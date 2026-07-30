import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { execute, type ExecutionResult } from "../../src/afterglow-graphql/execution/execute.ts";
import { parseSync } from "../../src/afterglow-graphql/language/parser.ts";
import {
  GraphQLInputObjectType,
  GraphQLInterfaceType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
} from "../../src/afterglow-graphql/type/definition.ts";
import { GraphQLInt, GraphQLString } from "../../src/afterglow-graphql/type/scalars.ts";
import { GraphQLSchema } from "../../src/afterglow-graphql/type/schema.ts";
import { validateSync } from "../../src/afterglow-graphql/validation/validate.ts";

const run = async (
  schema: GraphQLSchema,
  source: string,
  variableValues?: Record<string, unknown>,
): Promise<ExecutionResult> => {
  const document = parseSync(source);
  const validationErrors = validateSync(schema, document);
  if (validationErrors.length > 0) return { errors: validationErrors };
  return Effect.runPromise(execute({ schema, document, variableValues }));
};

const runExecutionOnly = async (
  schema: GraphQLSchema,
  source: string,
  variableValues?: Record<string, unknown>,
): Promise<ExecutionResult> =>
  Effect.runPromise(execute({ schema, document: parseSync(source), variableValues }));

describe("execution edge cases: list completion and null bubbling", () => {
  const Query = new GraphQLObjectType({
    name: "Query",
    fields: {
      nullableItems: {
        type: new GraphQLList(GraphQLString),
        resolve: () => ["a", new Error("bad item"), "c"],
      },
      nonNullItems: {
        type: new GraphQLList(new GraphQLNonNull(GraphQLString)),
        resolve: () => ["a", null, "c"],
      },
      nonNullList: {
        type: new GraphQLNonNull(new GraphQLList(GraphQLString)),
        resolve: () => null,
      },
      notIterable: {
        type: new GraphQLList(GraphQLString),
        resolve: () => ({ nope: true }),
      },
      badInt: {
        type: GraphQLInt,
        resolve: () => "not an int",
      },
      requiredArg: {
        type: GraphQLString,
        args: { value: { type: new GraphQLNonNull(GraphQLString) } },
        resolve: (_source, args) => args.value,
      },
    },
  });
  const schema = new GraphQLSchema({ query: Query });

  test("nullable list items become null and keep sibling items", async () => {
    const res = await run(schema, `{ nullableItems }`);

    expect(res.data).toEqual({ nullableItems: ["a", null, "c"] });
    expect(res.errors).toHaveLength(1);
    expect(res.errors![0]!.message).toBe("bad item");
    expect(res.errors![0]!.path).toEqual(["nullableItems", 1]);
  });

  test("null for a non-null list item nulls the nearest nullable list field", async () => {
    const res = await run(schema, `{ nonNullItems }`);

    expect(res.data).toEqual({ nonNullItems: null });
    expect(res.errors).toHaveLength(1);
    expect(res.errors![0]!.message).toBe(
      "Cannot return null for non-nullable field Query.nonNullItems.",
    );
    expect(res.errors![0]!.path).toEqual(["nonNullItems", 1]);
  });

  test("null for a non-null root field bubbles to data:null", async () => {
    const res = await run(schema, `{ nonNullList }`);

    expect(res.data).toBeNull();
    expect(res.errors).toHaveLength(1);
    expect(res.errors![0]!.path).toEqual(["nonNullList"]);
  });

  test("non-iterable list result is a field error at the list field path", async () => {
    const res = await run(schema, `{ notIterable }`);

    expect(res.data).toEqual({ notIterable: null });
    expect(res.errors).toHaveLength(1);
    expect(res.errors![0]!._tag).toBe("GraphQLFieldCompletionError");
    expect(res.errors![0]!.path).toEqual(["notIterable"]);
  });

  test("scalar serialization errors keep their concrete tag and field path", async () => {
    const res = await run(schema, `{ badInt }`);

    expect(res.data).toEqual({ badInt: null });
    expect(res.errors).toHaveLength(1);
    expect(res.errors![0]!._tag).toBe("GraphQLScalarCoercionError");
    expect(res.errors![0]!.message).toContain("Int cannot represent non-integer value");
    expect(res.errors![0]!.path).toEqual(["badInt"]);
    expect(res.errors![0]!.locations).toEqual([{ line: 1, column: 3 }]);
  });

  test("argument coercion errors keep their concrete tag and field path", async () => {
    const res = await runExecutionOnly(schema, `{ requiredArg }`);

    expect(res.data).toEqual({ requiredArg: null });
    expect(res.errors).toHaveLength(1);
    expect(res.errors![0]!._tag).toBe("GraphQLArgumentCoercionError");
    expect(res.errors![0]!.message).toContain('Argument "value" of required type "String!" was not provided.');
    expect(res.errors![0]!.path).toEqual(["requiredArg"]);
    expect(res.errors![0]!.locations).toEqual([{ line: 1, column: 3 }]);
  });
});

describe("execution edge cases: variable and input coercion", () => {
  const NestedInput = new GraphQLInputObjectType({
    name: "NestedInput",
    fields: {
      required: { type: new GraphQLNonNull(GraphQLString) },
      optional: { type: GraphQLInt, defaultValue: 7 },
    },
  });
  const WrapperInput = new GraphQLInputObjectType({
    name: "WrapperInput",
    fields: {
      child: { type: NestedInput },
    },
  });
  const Query = new GraphQLObjectType({
    name: "Query",
    fields: {
      echo: {
        type: GraphQLString,
        args: {
          input: { type: NestedInput },
          names: { type: new GraphQLList(GraphQLString) },
          label: { type: GraphQLString, defaultValue: "arg-default" },
        },
        resolve: (_source, args) => JSON.stringify(args),
      },
      echoWrapper: {
        type: GraphQLString,
        args: {
          wrapper: { type: WrapperInput },
        },
        resolve: (_source, args) => JSON.stringify(args),
      },
    },
  });
  const schema = new GraphQLSchema({ query: Query });

  test("nested input defaults and list singleton coercion are applied", async () => {
    const res = await run(
      schema,
      `query Q($input: NestedInput, $names: [String]) {
        echo(input: $input, names: $names)
      }`,
      { input: { required: "x" }, names: "ada" },
    );

    expect(res.errors).toBeUndefined();
    expect(JSON.parse((res.data as { echo: string }).echo)).toEqual({
      input: { required: "x", optional: 7 },
      names: ["ada"],
      label: "arg-default",
    });
  });

  test("unknown nested input fields report the nested variable path", async () => {
    const res = await run(
      schema,
      `query Q($wrapper: WrapperInput) { echoWrapper(wrapper: $wrapper) }`,
      { wrapper: { child: { required: "x", extra: true } } },
    );

    expect(res.data).toBeUndefined();
    expect(res.errors).toHaveLength(1);
    expect(res.errors![0]!._tag).toBe("GraphQLVariableCoercionError");
    expect(res.errors![0]!.message).toContain('at "wrapper.child"');
    expect(res.errors![0]!.message).toContain('Field "extra" is not defined');
  });

  test("inherited input object fields do not satisfy required fields", async () => {
    const inherited = Object.create({ required: "from-prototype" });

    const res = await run(
      schema,
      `query Q($input: NestedInput) { echo(input: $input) }`,
      { input: inherited },
    );

    expect(res.data).toBeUndefined();
    expect(res.errors).toHaveLength(1);
    expect(res.errors![0]!.message).toContain(
      'Field "required" of required type "String!" was not provided.',
    );
  });
});

describe("execution edge cases: abstract runtime type resolution", () => {
  const Named = new GraphQLInterfaceType({
    name: "Named",
    fields: {
      name: { type: GraphQLString },
    },
  });
  const Person = new GraphQLObjectType({
    name: "Person",
    interfaces: [Named],
    fields: {
      name: { type: GraphQLString },
    },
    isTypeOf: (value) => typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "person",
  });
  const Query = new GraphQLObjectType({
    name: "Query",
    fields: {
      named: {
        type: Named,
        resolve: () => ({ __typename: "Ghost", name: "bad" }),
      },
      inferred: {
        type: Named,
        resolve: () => ({ kind: "person", name: "Ada" }),
      },
    },
  });
  const schema = new GraphQLSchema({ query: Query, types: [Person] });

  test("invalid __typename on an abstract value is reported at the abstract field", async () => {
    const res = await run(schema, `{ named { __typename name } }`);

    expect(res.data).toEqual({ named: null });
    expect(res.errors).toHaveLength(1);
    expect(res.errors![0]!._tag).toBe("GraphQLRuntimeTypeError");
    expect(res.errors![0]!.message).toContain('type "Ghost" that does not exist');
    expect(res.errors![0]!.path).toEqual(["named"]);
  });

  test("default abstract resolver can infer type via isTypeOf", async () => {
    const res = await run(schema, `{ inferred { __typename name } }`);

    expect(res.errors).toBeUndefined();
    expect(res.data).toEqual({ inferred: { __typename: "Person", name: "Ada" } });
  });
});
