/**
 * HTTP transport. `GraphQL.toHttpApp(schemaLayer)` builds the `GraphQLSchema`
 * at construction time and returns an Effect-shaped HTTP handler whose `R`
 * channel carries every requirement reachable from the schemaLayer.
 *
 * Service provision is the standard Effect seam — `Layer.provide` for
 * server-scoped services, `HttpRouter.provideRequest` (or any layer that
 * depends on `HttpServerRequest`) for per-request services. The framework
 * doesn't take a `runtime` or `requestContext` option: requirements flow
 * through `R` and the user composes services exactly as they would for any
 * other Effect program.
 *
 *     const app = GraphQL.toHttpApp(SchemaLayer)
 *     // app: Effect<Response, never, HttpServerRequest | TodoStore | CurrentUser>
 *
 *     const program = pipe(
 *       HttpRouter.add("POST", "/graphql", app),
 *       Layer.provide(TodoStoreLive),
 *       Layer.provide(CurrentUserLive), // depends on HttpServerRequest -> per-request
 *       HttpServer.serve,
 *       Layer.launch,
 *     )
 */
import { Context, Effect, Layer, Schema } from "effect";
import {
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import {
  GraphQLSyntaxError,
  isGraphQLError,
} from "../alembic-graphql/error/graph-ql-error.ts";
import { Source } from "../alembic-graphql/language/source.ts";
import type { DocumentNode } from "../alembic-graphql/language/ast.ts";
import { execute } from "../alembic-graphql/execution/execute.ts";
import type { ExecutionResult } from "../alembic-graphql/execution/execute.ts";
import { parseSync } from "../alembic-graphql/language/parser.ts";
import { validateSync } from "../alembic-graphql/validation/validate.ts";
import { GraphQLSchema } from "../alembic-graphql/type/schema.ts";
import {
  HttpRequestError,
  OperationParseError,
  OperationValidationError,
  PersistedQueryNotFound,
} from "../errors.ts";
import { graphqlErrorJSON } from "../runtime/error-format.ts";
import { executeBfsEffect } from "../runtime/executor.ts";
import { lower } from "../schema/compile.ts";
import { withFragmentCapture } from "../registry.ts";

type DispatchError =
  | HttpRequestError
  | OperationParseError
  | OperationValidationError
  | PersistedQueryNotFound;

/**
 * Pre-registered persisted-queries options. Strict allowlist mode only.
 */
export interface PersistedQueriesOptions {
  readonly store:
    | ReadonlyMap<string, string>
    | { get(hash: string): string | undefined };
  readonly field?: string;
  readonly required?: boolean;
}

/** Options for `toHttpApp`. */
export interface ToHttpAppOptions {
  readonly allowGet?: boolean;
  readonly graphiql?:
    | boolean
    | { readonly title?: string; readonly defaultQuery?: string };
  readonly persistedQueries?: PersistedQueriesOptions;
  /**
   *  - `"default"` (the default): Alembic Effect execution.
   *  - `"bfs"`: the level-order executor that pairs with `RequestResolver`
   *    auto-batching.
   */
  readonly executor?: "default" | "bfs";
  /**
   * Suppress lint warnings by code (e.g. `["RELAY-104"]`). Errors are NEVER
   * mutable. See `src/lint.ts` for the full set.
   */
  readonly muteLintWarnings?: ReadonlyArray<string>;
}

/**
 * Build the `GraphQLSchema` from a `Layer.mergeAll(...)` schema spec. Useful
 * for tests and alternative transports.
 */
export const buildSchema = <R>(
  schemaLayer: Layer.Layer<never, never, R>,
  options: { readonly muteLintWarnings?: ReadonlyArray<string> } = {},
): GraphQLSchema => {
  const { ir } = withFragmentCapture(() => {
    const buildEff = Layer.build(schemaLayer);
    const scoped = Effect.scoped(buildEff) as Effect.Effect<unknown, never, never>;
    Effect.runSync(scoped);
    return null;
  });
  return lower(ir, { muteLintWarnings: options.muteLintWarnings });
};

const DEFAULT_PQ_FIELD = "doc_id";

const PostBodySchema = Schema.Record(Schema.String, Schema.Unknown);

interface ParsedRequest {
  readonly query: string | undefined;
  readonly variables: Record<string, unknown> | undefined;
  readonly operationName: string | undefined;
  readonly raw: Record<string, unknown>;
}

export const toHttpApp = <R>(
  schemaLayer: Layer.Layer<never, never, R>,
  options?: ToHttpAppOptions,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  HttpServerRequest.HttpServerRequest | R
> => {
  const schema = buildSchema(schemaLayer, {
    muteLintWarnings: options?.muteLintWarnings,
  });

  const allowGet = options?.allowGet !== false;
  const graphiqlOpt = options?.graphiql ?? true;
  const graphiqlEnabled = graphiqlOpt !== false;
  const graphiqlConfig = typeof graphiqlOpt === "object" ? graphiqlOpt : {};
  const executorKind = options?.executor ?? "default";
  const pq = options?.persistedQueries;
  const pqField = pq?.field ?? DEFAULT_PQ_FIELD;
  const pqRequired = pq?.required === true;
  const pqLookup = (hash: string): string | undefined => pq?.store.get(hash);
  const documentCache = new Map<string, DocumentNode>();

  const dispatch: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    DispatchError,
    HttpServerRequest.HttpServerRequest | R
  > = Effect.gen(function* () {
    const req = yield* HttpServerRequest.HttpServerRequest;

    if (
      graphiqlEnabled &&
      req.method === "GET" &&
      prefersHtml(req.headers["accept"])
    ) {
      return HttpServerResponse.html(graphiqlHtml(graphiqlConfig));
    }

    const initial = yield* parseRequest(req, allowGet);
    const afterPq = yield* applyPersistedQuery(initial, {
      pq,
      pqField,
      pqLookup,
      pqRequired,
    });

    if (afterPq.query === undefined || afterPq.query === "") {
      return yield* Effect.fail(
        new HttpRequestError({
          status: 400,
          reason: "Missing 'query' parameter",
        }),
      );
    }

    const document = yield* getValidatedDocument(
      schema,
      documentCache,
      afterPq.query,
    );

    if (req.method === "GET" && containsMutation(document, afterPq.operationName)) {
      return yield* Effect.fail(
        new HttpRequestError({
          status: 405,
          reason: "GET requests are only allowed for query operations",
        }),
      );
    }

    // Capture the current Context — this carries every service in R, however
    // the user composed it (server-scoped via `Layer.provide`, per-request via
    // a layer depending on HttpServerRequest, etc.). The executor receives this
    // as `contextValue`; the resolver bridge provides it back into the user
    // resolver Effect.
    const contextValue = yield* Effect.context<R>();

    const executeEff: Effect.Effect<ExecutionResult, never, R> =
      executorKind === "bfs"
        ? executeBfsEffect({
            schema,
            document,
            contextValue,
            variableValues: afterPq.variables,
            operationName: afterPq.operationName,
          })
        : execute<R>({
            schema,
            document,
            contextValue,
            variableValues: afterPq.variables,
            operationName: afterPq.operationName,
          });

    const result: ExecutionResult = yield* executeEff.pipe(
      Effect.withSpan("graphql.execute", {
        attributes: {
          "graphql.operation_name": afterPq.operationName ?? "anonymous",
        },
      }),
    );

    return yield* jsonResponse(result, 200);
  });

  const tracedDispatch = Effect.gen(function* () {
    const req = yield* HttpServerRequest.HttpServerRequest;
    return yield* dispatch.pipe(
      Effect.withSpan("graphql.http_request", {
        attributes: { "http.method": req.method },
      }),
    );
  });

  return tracedDispatch.pipe(
    Effect.catchTags({
      HttpRequestError: (e) => httpRequestErrorResponse(e),
      OperationParseError: (e) =>
        jsonResponse({ errors: e.errors.map(graphqlErrorJSON) }, 200),
      OperationValidationError: (e) =>
        jsonResponse({ errors: e.errors.map(graphqlErrorJSON) }, 200),
      PersistedQueryNotFound: (e) =>
        jsonResponse(
          {
            errors: [
              {
                message: "PersistedQueryNotFound",
                extensions: { code: "PERSISTED_QUERY_NOT_FOUND", hash: e.hash },
              },
            ],
          },
          200,
        ),
    }),
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
  );
};

// ---------------------------------------------------------------------------
// Pipeline stages
// ---------------------------------------------------------------------------

const parseRequest = (
  req: HttpServerRequest.HttpServerRequest,
  allowGet: boolean,
): Effect.Effect<ParsedRequest, HttpRequestError, HttpServerRequest.HttpServerRequest> => {
  if (req.method === "POST") return parsePostBody();
  if (req.method === "GET") {
    if (!allowGet) {
      return Effect.fail(
        new HttpRequestError({
          status: 405,
          reason: "GET requests are disabled for this endpoint",
        }),
      );
    }
    return Effect.succeed(parseGetRequest(req));
  }
  return Effect.fail(
    new HttpRequestError({
      status: 405,
      reason: `Method ${req.method} not allowed`,
    }),
  );
};

const parsePostBody = (): Effect.Effect<
  ParsedRequest,
  HttpRequestError,
  HttpServerRequest.HttpServerRequest
> =>
  HttpServerRequest.schemaBodyJson(PostBodySchema).pipe(
    Effect.map((body): ParsedRequest => {
      const raw = body as Record<string, unknown>;
      const query = typeof raw["query"] === "string" ? raw["query"] : undefined;
      const variablesRaw = raw["variables"];
      const variables =
        variablesRaw !== null && typeof variablesRaw === "object"
          ? (variablesRaw as Record<string, unknown>)
          : undefined;
      const opNameRaw = raw["operationName"];
      const operationName = typeof opNameRaw === "string" ? opNameRaw : undefined;
      return { query, variables, operationName, raw };
    }),
    Effect.mapError(
      (e) =>
        new HttpRequestError({
          status: 400,
          reason: `Invalid request body: ${e instanceof Error ? e.message : String(e)}`,
        }),
    ),
  );

const parseGetRequest = (req: HttpServerRequest.HttpServerRequest): ParsedRequest => {
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
      variables = undefined;
    }
  }
  const raw: Record<string, unknown> = {};
  if (query !== undefined) raw["query"] = query;
  if (operationName !== undefined) raw["operationName"] = operationName;
  if (variables !== undefined) raw["variables"] = variables;
  for (const [k, v] of url.searchParams) {
    if (k === "query" || k === "operationName" || k === "variables") continue;
    raw[k] = v;
  }
  return { query, variables, operationName, raw };
};

const applyPersistedQuery = (
  parsed: ParsedRequest,
  cfg: {
    pq: PersistedQueriesOptions | undefined;
    pqField: string;
    pqLookup: (hash: string) => string | undefined;
    pqRequired: boolean;
  },
): Effect.Effect<ParsedRequest, HttpRequestError | PersistedQueryNotFound, never> => {
  if (cfg.pq === undefined) return Effect.succeed(parsed);
  const hashRaw = parsed.raw[cfg.pqField];
  const hash = typeof hashRaw === "string" ? hashRaw : undefined;
  if (hash !== undefined && hash !== "") {
    const resolved = cfg.pqLookup(hash);
    if (resolved === undefined) {
      return Effect.fail(new PersistedQueryNotFound({ hash }));
    }
    return Effect.succeed({ ...parsed, query: resolved });
  }
  if (cfg.pqRequired) {
    return Effect.fail(
      new HttpRequestError({
        status: 400,
        reason: "Persisted query hash required",
      }),
    );
  }
  return Effect.succeed(parsed);
};

const parseDocument = (
  source: string,
): Effect.Effect<DocumentNode, OperationParseError, never> =>
  Effect.try({
    try: () => parseSync(new Source(source, "GraphQL request")),
    catch: (err) =>
      new OperationParseError({
        errors: isGraphQLError(err)
          ? [err]
          : [new GraphQLSyntaxError(new Source(source, "GraphQL request"), 0, String(err))],
      }),
  }).pipe(
    Effect.withSpan("graphql.parse", {
      attributes: { "graphql.source": source.slice(0, 200) },
    }),
  );

const validateDocument = (
  schema: GraphQLSchema,
  document: DocumentNode,
): Effect.Effect<void, OperationValidationError, never> =>
  Effect.suspend(() => {
    // alembic's validateSync expects its own GraphQLSchema; structurally
    // equivalent to Alembic's visitor keys, but we cast to satisfy the bridge
    // into typed visitor utilities.
    const errors = validateSync(schema, document);
    if (errors.length === 0) return Effect.void;
    return Effect.fail(new OperationValidationError({ errors }));
  }).pipe(Effect.withSpan("graphql.validate"));

const getValidatedDocument = (
  schema: GraphQLSchema,
  cache: Map<string, DocumentNode>,
  source: string,
): Effect.Effect<DocumentNode, OperationParseError | OperationValidationError, never> => {
  const cached = cache.get(source);
  if (cached !== undefined) return Effect.succeed(cached);

  return Effect.gen(function* () {
    const document = yield* parseDocument(source);
    yield* validateDocument(schema, document);
    cache.set(source, document);
    return document;
  });
};

// ---------------------------------------------------------------------------
// Edge mappers
// ---------------------------------------------------------------------------

const httpRequestErrorResponse = (
  e: HttpRequestError,
): Effect.Effect<HttpServerResponse.HttpServerResponse> => {
  const codeByStatus: Record<number, string> = {
    400: "INVALID_REQUEST_BODY",
    405: "METHOD_NOT_ALLOWED",
  };
  return jsonResponse(
    {
      errors: [
        {
          message: e.reason,
          extensions: { code: codeByStatus[e.status] ?? "BAD_REQUEST" },
        },
      ],
    },
    e.status,
  );
};

const containsMutation = (
  document: DocumentNode,
  operationName: string | undefined,
): boolean => {
  for (const def of document.definitions) {
    if (def.kind !== "OperationDefinition") continue;
    if (operationName !== undefined && def.name?.value !== operationName) continue;
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
  if (cause instanceof Error) return cause.message;
  try {
    return String(cause);
  } catch {
    return "unknown";
  }
};
