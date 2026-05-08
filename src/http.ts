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
  type GraphQLSchema,
} from "graphql";

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
 */
export interface ToHttpAppOptions<ReqR = never> {
  readonly requestContext?: Layer.Layer<
    ReqR,
    never,
    HttpServerRequest.HttpServerRequest
  >;
  readonly allowGet?: boolean;
}

/**
 * Body schema for POST requests. We accept any JSON shape and post-validate
 * required fields ourselves so we can return GraphQL-shaped errors rather
 * than the schema's own. `query` is optional in the schema (GET supplies it
 * in URL params), but the handler enforces presence after dispatch.
 */
const PostBodySchema = Schema.Struct({
  query: Schema.optionalKey(Schema.String),
  variables: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  operationName: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

interface ParsedRequest {
  readonly query: string | undefined;
  readonly variables: Record<string, unknown> | undefined;
  readonly operationName: string | undefined;
}

/**
 * Build a handler suitable for `HttpRouter.add(method, path, handler)`. Returns
 * an `Effect` that consumes the in-scope `HttpServerRequest` (provided by the
 * router) plus whatever services the user's `requestContext` Layer requires.
 *
 * Mounting:
 *
 * ```ts
 * import { GraphQL } from "effect-graphql"
 * import { HttpRouter } from "effect/unstable/http"
 *
 * const app = GraphQL.toHttpApp(schema, { requestContext: MyLayer })
 * HttpRouter.add("POST", "/graphql", app)
 * HttpRouter.add("GET",  "/graphql", app)
 * ```
 */
export const toHttpApp = <ReqR = never>(
  schema: GraphQLSchema,
  options?: ToHttpAppOptions<ReqR>,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  HttpServerRequest.HttpServerRequest
> => {
  const allowGet = options?.allowGet !== false;
  const requestContext = options?.requestContext;

  const handler = Effect.gen(function* () {
    const req = yield* HttpServerRequest.HttpServerRequest;

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
      Promise.resolve(
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
    Effect.map((body) => ({
      query: body.query,
      variables: body.variables as Record<string, unknown> | undefined,
      operationName: body.operationName ?? undefined,
    })),
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
  return { query, variables, operationName };
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

const causeMessage = (cause: unknown): string => {
  // Best-effort, opaque description; we don't expose defect detail by default.
  if (cause instanceof Error) return cause.message;
  try {
    return String(cause);
  } catch {
    return "unknown";
  }
};
