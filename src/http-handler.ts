import { Context, Effect, Layer, Schema } from "effect";
import {
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import {
  execute,
  GraphQLError,
  parse,
  Source,
  validate,
  type DocumentNode,
  type ExecutionResult,
} from "graphql";
import { executeBfs } from "./executor-bfs.ts";

// Schema is opaque to the handler — it only forwards through to graphql-js's
// `execute`/`validate`/`parse`. The `ReqR` brand exists only at the type level
// to constrain the contextValue shape that flows in.
type TypedGraphQLSchema<_ReqR> = import("graphql").GraphQLSchema;

/**
 * Pre-registered persisted-queries options. Strict allowlist mode only — there
 * is no Apollo APQ-style retry handshake.
 *
 *  - `store`: a static `{ hash → query text }` map. The build-time output of
 *    `relay-compiler --persist-output queryMap.json`.
 *  - `field`: the request body field that carries the hash. Defaults to
 *    `"doc_id"` (Relay's documented network-layer convention).
 *  - `required`: when `true`, requests without a hash are rejected with 400.
 *    Defaults to `false`, allowing ad-hoc queries through (dev-friendly).
 *    Recommended `true` in production.
 */
export interface PersistedQueriesOptions {
  readonly store:
    | ReadonlyMap<string, string>
    | { get(hash: string): string | undefined };
  readonly field?: string;
  readonly required?: boolean;
}

/**
 * Options for `toHttpApp`.
 *
 *  - `requestContext`: a `Layer` that produces the per-request services
 *    `ReqR` from an `HttpServerRequest`. Built fresh each request. If omitted,
 *    each resolver receives `Context.empty()` (suitable when no per-request
 *    services are needed).
 *  - `allowGet`: enable `GET /graphql?query=...` for query operations. Defaults
 *    to `true`. Mutations on GET always reject with 405 per the GraphQL-over-
 *    HTTP spec.
 *  - `graphiql`: serve the GraphiQL IDE on `GET /graphql` when the client
 *    prefers `text/html`. Defaults to `true`. Set to `false` to disable (e.g.
 *    in production), or pass `{ title, defaultQuery }` to customize.
 *  - `persistedQueries`: enable Relay-compatible pre-registered persisted
 *    queries. See `PersistedQueriesOptions`.
 */
export interface ToHttpAppOptions<ReqR = never> {
  readonly requestContext?: Layer.Layer<
    ReqR,
    never,
    HttpServerRequest.HttpServerRequest
  >;
  readonly allowGet?: boolean;
  readonly graphiql?:
    | boolean
    | { readonly title?: string; readonly defaultQuery?: string };
  readonly persistedQueries?: PersistedQueriesOptions;
  /**
   * Which executor to use for resolving operations.
   *
   *  - `"default"` (the default): graphql-js's built-in `execute()`. Decade of
   *    bug-fixes; this is the correctness baseline.
   *  - `"bfs"`: a level-order executor that runs every field at a given depth
   *    in a single concurrent batch. Pairs with Effect's `RequestResolver`
   *    auto-batching: a level becomes the natural batching window. Custom
   *    code — see `src/executor-bfs.ts` and the parity test suite.
   */
  readonly executor?: "default" | "bfs";
}

const DEFAULT_PQ_FIELD = "doc_id";

/**
 * Body schema for POST requests. We accept any JSON shape and post-validate
 * required fields ourselves so we can return GraphQL-shaped errors rather
 * than the schema's own. `query` is optional in the schema (GET supplies it
 * in URL params), but the handler enforces presence after dispatch.
 *
 * The struct is open: unknown fields (e.g. the configured persisted-query
 * hash field) pass through and are read from the raw record by name.
 */
const PostBodySchema = Schema.Record(Schema.String, Schema.Unknown);

interface ParsedRequest {
  readonly query: string | undefined;
  readonly variables: Record<string, unknown> | undefined;
  readonly operationName: string | undefined;
  readonly raw: Record<string, unknown>;
}

/**
 * Build a handler suitable for `HttpRouter.add(method, path, handler)`. Returns
 * an `Effect` that consumes the in-scope `HttpServerRequest` (provided by the
 * router) plus whatever services the user's `requestContext` Layer requires.
 *
 * Mounting:
 *
 * ```ts
 * import { GraphQL } from "@athanor/alembic"
 * import { HttpRouter } from "effect/unstable/http"
 *
 * const app = GraphQL.toHttpApp(schema, { requestContext: MyLayer })
 * HttpRouter.add("POST", "/graphql", app)
 * HttpRouter.add("GET",  "/graphql", app)
 * ```
 */
export const toHttpApp = <ReqR = never>(
  schema: TypedGraphQLSchema<ReqR>,
  options?: ToHttpAppOptions<ReqR>,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  HttpServerRequest.HttpServerRequest
> => {
  const allowGet = options?.allowGet !== false;
  const requestContext = options?.requestContext;
  const graphiqlOpt = options?.graphiql ?? true;
  const graphiqlEnabled = graphiqlOpt !== false;
  const graphiqlConfig =
    typeof graphiqlOpt === "object" ? graphiqlOpt : {};
  const executorKind = options?.executor ?? "default";
  const pq = options?.persistedQueries;
  const pqField = pq?.field ?? DEFAULT_PQ_FIELD;
  const pqRequired = pq?.required === true;
  const pqLookup = (hash: string): string | undefined => {
    if (pq === undefined) return undefined;
    const store = pq.store;
    if (store instanceof Map) return store.get(hash);
    return store.get(hash);
  };

  const handler = Effect.gen(function* () {
    const req = yield* HttpServerRequest.HttpServerRequest;

    if (
      graphiqlEnabled &&
      req.method === "GET" &&
      prefersHtml(req.headers["accept"])
    ) {
      return HttpServerResponse.html(graphiqlHtml(graphiqlConfig));
    }

    let parsed: ParsedRequest;
    if (req.method === "POST") {
      const result = yield* Effect.result(parsePostBody());
      if (result._tag === "Failure") {
        return yield* jsonResponse(
          { errors: [graphqlErrorJSON(result.failure)] },
          400,
        );
      }
      parsed = result.success;
    } else if (req.method === "GET") {
      if (!allowGet) {
        return yield* jsonResponse(
          {
            errors: [
              {
                message: "GET requests are disabled for this endpoint",
                extensions: { code: "METHOD_NOT_ALLOWED" },
              },
            ],
          },
          405,
        );
      }
      parsed = parseGetRequest(req);
    } else {
      return yield* jsonResponse(
        {
          errors: [
            {
              message: `Method ${req.method} not allowed`,
              extensions: { code: "METHOD_NOT_ALLOWED" },
            },
          ],
        },
        405,
      );
    }

    // Persisted queries: relay-compiler emits a static { hash → query } map
    // and the client sends only the hash. Strict allowlist mode — no APQ
    // retry handshake. See `PersistedQueriesOptions`.
    if (pq !== undefined) {
      const hashRaw = parsed.raw[pqField];
      const hash = typeof hashRaw === "string" ? hashRaw : undefined;
      if (hash !== undefined && hash !== "") {
        const resolved = pqLookup(hash);
        if (resolved === undefined) {
          return yield* jsonResponse(
            {
              errors: [
                {
                  message: "PersistedQueryNotFound",
                  extensions: {
                    code: "PERSISTED_QUERY_NOT_FOUND",
                    hash,
                  },
                },
              ],
            },
            200,
          );
        }
        parsed = { ...parsed, query: resolved };
      } else if (pqRequired) {
        return yield* jsonResponse(
          {
            errors: [
              {
                message: "Persisted query hash required",
                extensions: { code: "PERSISTED_QUERY_REQUIRED" },
              },
            ],
          },
          400,
        );
      }
    }

    if (parsed.query === undefined || parsed.query === "") {
      return yield* jsonResponse(
        {
          errors: [
            {
              message: "Missing 'query' parameter",
              extensions: { code: "INVALID_REQUEST_BODY" },
            },
          ],
        },
        400,
      );
    }

    let document: DocumentNode;
    try {
      document = parse(new Source(parsed.query, "GraphQL request"));
    } catch (err) {
      const errors =
        err instanceof GraphQLError
          ? [err]
          : [new GraphQLError(String(err))];
      return yield* jsonResponse(
        { errors: errors.map(graphqlErrorJSON) },
        200,
      );
    }

    const validationErrors = validate(schema, document);
    if (validationErrors.length > 0) {
      return yield* jsonResponse(
        { errors: validationErrors.map(graphqlErrorJSON) },
        200,
      );
    }

    if (req.method === "GET" && containsMutation(document, parsed.operationName)) {
      return yield* jsonResponse(
        {
          errors: [
            {
              message: "GET requests are only allowed for query operations",
              extensions: { code: "METHOD_NOT_ALLOWED" },
            },
          ],
        },
        405,
      );
    }

    // Build per-request context. If the user supplied a Layer, run it to a
    // Context<ReqR>; else hand graphql-js an empty Context. Context<ReqR> is
    // the GraphQL `contextValue` — see runtime.ts wrapResolver: it merges this
    // with the server-scoped runtime via `Effect.provide(eff, ctx)`.
    let contextValue: Context.Context<ReqR>;
    if (requestContext !== undefined) {
      contextValue = (yield* Effect.provide(
        Effect.context<ReqR>(),
        requestContext,
      )) as Context.Context<ReqR>;
    } else {
      contextValue = Context.empty() as Context.Context<ReqR>;
    }

    const result: ExecutionResult = yield* Effect.promise(() =>
      executorKind === "bfs"
        ? executeBfs({
            schema,
            document,
            contextValue,
            variableValues: parsed.variables,
            operationName: parsed.operationName,
          })
        : Promise.resolve(
            execute({
              schema,
              document,
              contextValue,
              variableValues: parsed.variables,
              operationName: parsed.operationName,
            }),
          ),
    );

    return yield* jsonResponse(result, 200);
  });

  // Catch defects so the handler signature is `never` for E. Body parse and
  // user-context Layer errors are converted to JSON above; uncaught throws
  // become 500s.
  return handler.pipe(
    Effect.catchCause((cause) =>
      jsonResponse(
        {
          errors: [
            {
              message: "Internal server error",
              extensions: {
                code: "INTERNAL_SERVER_ERROR",
                detail: causeMessage(cause),
              },
            },
          ],
        },
        500,
      ),
    ),
  ) as Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    never,
    HttpServerRequest.HttpServerRequest
  >;
};

const parsePostBody = (): Effect.Effect<
  ParsedRequest,
  Error,
  HttpServerRequest.HttpServerRequest
> =>
  HttpServerRequest.schemaBodyJson(PostBodySchema).pipe(
    Effect.map((body) => {
      const raw = body as Record<string, unknown>;
      const query = typeof raw["query"] === "string" ? (raw["query"] as string) : undefined;
      const variablesRaw = raw["variables"];
      const variables =
        variablesRaw !== null && typeof variablesRaw === "object"
          ? (variablesRaw as Record<string, unknown>)
          : undefined;
      const opNameRaw = raw["operationName"];
      const operationName =
        typeof opNameRaw === "string" ? opNameRaw : undefined;
      return { query, variables, operationName, raw };
    }),
    Effect.mapError(
      (e) =>
        new Error(
          `Invalid request body: ${e instanceof Error ? e.message : String(e)}`,
        ),
    ),
  );

const parseGetRequest = (
  req: HttpServerRequest.HttpServerRequest,
): ParsedRequest => {
  // req.url is the request path including query string ("/graphql?query=...").
  // URL needs an absolute base, so use a dummy origin.
  const url = new URL(req.url, "http://localhost");
  const query = url.searchParams.get("query") ?? undefined;
  const operationName = url.searchParams.get("operationName") ?? undefined;
  const rawVariables = url.searchParams.get("variables");
  let variables: Record<string, unknown> | undefined;
  if (rawVariables !== null && rawVariables !== "") {
    try {
      const decoded = JSON.parse(rawVariables);
      if (decoded !== null && typeof decoded === "object") {
        variables = decoded as Record<string, unknown>;
      }
    } catch {
      // Surface as a missing-variables case; execute will validate.
      variables = undefined;
    }
  }
  const raw: Record<string, unknown> = {};
  if (query !== undefined) raw["query"] = query;
  if (operationName !== undefined) raw["operationName"] = operationName;
  if (variables !== undefined) raw["variables"] = variables;
  // Hash via URL param: relay-runtime's default GET fetch sends the same
  // body field as a query-string parameter. Mirror that.
  for (const [k, v] of url.searchParams) {
    if (k === "query" || k === "operationName" || k === "variables") continue;
    raw[k] = v;
  }
  return { query, variables, operationName, raw };
};

const containsMutation = (
  document: DocumentNode,
  operationName: string | undefined,
): boolean => {
  for (const def of document.definitions) {
    if (def.kind !== "OperationDefinition") continue;
    if (
      operationName !== undefined &&
      def.name?.value !== operationName
    ) {
      continue;
    }
    if (def.operation === "mutation") return true;
  }
  return false;
};

const jsonResponse = (
  body: unknown,
  status: number,
): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
  HttpServerResponse.json(body, { status }).pipe(
    Effect.orElseSucceed(() =>
      HttpServerResponse.text(
        '{"errors":[{"message":"Failed to serialize response"}]}',
        { status: 500, contentType: "application/json" },
      ),
    ),
  );

const graphqlErrorJSON = (err: unknown): Record<string, unknown> => {
  if (err instanceof GraphQLError) {
    return err.toJSON() as unknown as Record<string, unknown>;
  }
  if (err instanceof Error) return { message: err.message };
  return { message: String(err) };
};

// Browser preference check: prefer html only when the client clearly asks for
// it (browser navigation) and is not asking for JSON (programmatic clients
// often send `Accept: application/json, text/html` or `*/*`).
const prefersHtml = (accept: string | undefined): boolean => {
  if (accept === undefined || accept === "") return false;
  const lower = accept.toLowerCase();
  if (!lower.includes("text/html")) return false;
  if (lower.includes("application/json")) return false;
  return true;
};

const GRAPHIQL_VERSION = "3";

const graphiqlHtml = (opts: {
  readonly title?: string;
  readonly defaultQuery?: string;
}): string => {
  const title = opts.title ?? "GraphiQL";
  const defaultQuery = opts.defaultQuery ?? "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <style>body { margin: 0; height: 100vh; } #graphiql { height: 100%; }</style>
  <link rel="stylesheet" href="https://unpkg.com/graphiql@${GRAPHIQL_VERSION}/graphiql.min.css" />
</head>
<body>
  <div id="graphiql"></div>
  <script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
  <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
  <script crossorigin src="https://unpkg.com/graphiql@${GRAPHIQL_VERSION}/graphiql.min.js"></script>
  <script>
    const fetcher = GraphiQL.createFetcher({ url: window.location.pathname });
    ReactDOM.createRoot(document.getElementById('graphiql')).render(
      React.createElement(GraphiQL, {
        fetcher,
        defaultQuery: ${JSON.stringify(defaultQuery)}
      })
    );
  </script>
</body>
</html>`;
};

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]!);

const causeMessage = (cause: unknown): string => {
  // Best-effort, opaque description; we don't expose defect detail by default.
  if (cause instanceof Error) return cause.message;
  try {
    return String(cause);
  } catch {
    return "unknown";
  }
};
