import { Context, Effect, Layer, Schema } from "effect";
import { parseSync as parse } from "../src/alembic-graphql/language/parser.ts";
import {
  compileExecutionArtifact,
  execute as executeEffect,
} from "../src/alembic-graphql/execution/execute.ts";
import { GraphQL } from "../src/index.ts";
import { buildSchema } from "../src/transport/http.ts";
import { bench, benchAsync, formatResult, type BenchResult } from "./harness.ts";

const EMPTY_CTX = Context.empty() as Context.Context<unknown>;
const EMPTY_ARGS = Object.freeze({});

class BenchUser extends Schema.Class<BenchUser>("BenchUserOverhead")({
  id: Schema.String,
  name: Schema.String,
}) {}

const user = new BenchUser({ id: "1", name: "alice" });

const UserNode = GraphQL.Node.layer(BenchUser)({
  fields: () => ({ name: Schema.String }),
  load: (id) => Effect.succeed(new BenchUser({ id, name: `user-${id}` })),
});

const QueryLayer = GraphQL.Query.layer({
  user: GraphQL.queryField(BenchUser, {
    resolve: () => Effect.succeed(user),
  }),
});

const schema = buildSchema(Layer.mergeAll(UserNode, QueryLayer));
const document = parse("{ user { id name } }");
const artifact = compileExecutionArtifact({ schema, document, contextValue: EMPTY_CTX });

if (artifact === null) {
  throw new Error("expected artifact-overhead benchmark to compile");
}

const userField = schema.getQueryType()!.getFields().user!;
const userResolver = userField.extensions.alembicResolver!.resolve;

const runDirectObject = () => {
  return { data: { user: { id: "1", name: "alice" } } };
};

const runResolverOnly = () => {
  return Effect.runSync(userResolver(undefined, EMPTY_ARGS, EMPTY_CTX, undefined) as Effect.Effect<unknown>);
};

const runResolverManualResponse = () => {
  const resolved = Effect.runSync(
    userResolver(undefined, EMPTY_ARGS, EMPTY_CTX, undefined) as Effect.Effect<BenchUser>,
  );
  return { data: { user: { id: resolved.id, name: resolved.name } } };
};

const runDefaultEffect = () => {
  const result = Effect.runSync(executeEffect({ schema, document, contextValue: EMPTY_CTX }));
  if (result.errors) throw new Error(JSON.stringify(result));
  return result;
};

const runArtifactEffect = () => {
  const result = Effect.runSync(artifact.execute());
  if (result.errors) throw new Error(JSON.stringify(result));
  return result;
};

const runDefaultPromise = async () => {
  const result = await Effect.runPromise(executeEffect({ schema, document, contextValue: EMPTY_CTX }));
  if (result.errors) throw new Error(JSON.stringify(result));
  return result;
};

const runArtifactPromise = async () => {
  const result = await Effect.runPromise(artifact.execute());
  if (result.errors) throw new Error(JSON.stringify(result));
  return result;
};

export const main = async (): Promise<BenchResult[]> => {
  const results: BenchResult[] = [];
  results.push(await bench("isolated floor / direct object response", runDirectObject));
  results.push(await bench("isolated floor / resolver Effect.runSync only", runResolverOnly));
  results.push(await bench("isolated floor / resolver + manual response", runResolverManualResponse));
  results.push(await bench("isolated single / execute() Effect.runSync", runDefaultEffect));
  results.push(await bench("isolated single / artifact Effect.runSync", runArtifactEffect));
  results.push(await benchAsync("isolated single / execute() Effect.runPromise", runDefaultPromise));
  results.push(await benchAsync("isolated single / artifact Effect.runPromise", runArtifactPromise));
  return results;
};

if (import.meta.main) {
  const results = await main();
  console.log("\nArtifact overhead\n");
  for (const result of results) console.log(formatResult(result));
}
