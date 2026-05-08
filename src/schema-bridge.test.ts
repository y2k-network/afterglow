import { describe, expect, test } from "bun:test";
import { Schema, SchemaGetter } from "effect";
import {
  GraphQLBoolean,
  GraphQLEnumType,
  GraphQLFloat,
  GraphQLInputObjectType,
  GraphQLList,
  GraphQLScalarType,
  GraphQLString,
  Kind,
  type GraphQLNamedType,
  type ValueNode,
} from "graphql";
import { schemaToInputType, schemaToScalar } from "./schema-bridge.ts";

const newRegistry = (): Map<string, GraphQLNamedType> => new Map();

describe("schemaToInputType", () => {
  test("Schema.String → GraphQLString", () => {
    expect(schemaToInputType(Schema.String, newRegistry())).toBe(GraphQLString);
  });

  test("Schema.Number → GraphQLFloat", () => {
    expect(schemaToInputType(Schema.Number, newRegistry())).toBe(GraphQLFloat);
  });

  test("Schema.Boolean → GraphQLBoolean", () => {
    expect(schemaToInputType(Schema.Boolean, newRegistry())).toBe(GraphQLBoolean);
  });

  test("string-literal Union with identifier → GraphQLEnumType", () => {
    const Status = Schema.Union([
      Schema.Literal("active"),
      Schema.Literal("inactive"),
    ]).annotate({ identifier: "Status" });
    const out = schemaToInputType(Status, newRegistry());
    expect(out).toBeInstanceOf(GraphQLEnumType);
    const enumType = out as GraphQLEnumType;
    expect(enumType.name).toBe("Status");
    expect(enumType.getValues().map((v) => v.name).sort()).toEqual(["active", "inactive"]);
  });

  test("string-literal Union without identifier → throws", () => {
    const U = Schema.Union([Schema.Literal("a"), Schema.Literal("b")]);
    expect(() => schemaToInputType(U, newRegistry())).toThrow(/identifier annotation/);
  });

  test("Schema.Struct with identifier → GraphQLInputObjectType", () => {
    const Input = Schema.Struct({
      name: Schema.String,
      age: Schema.Number,
      active: Schema.Boolean,
    }).annotate({ identifier: "UserInput" });
    const reg = newRegistry();
    const out = schemaToInputType(Input, reg);
    expect(out).toBeInstanceOf(GraphQLInputObjectType);
    const obj = out as GraphQLInputObjectType;
    expect(obj.name).toBe("UserInput");
    const fields = obj.getFields();
    expect(fields.name!.type).toBe(GraphQLString);
    expect(fields.age!.type).toBe(GraphQLFloat);
    expect(fields.active!.type).toBe(GraphQLBoolean);
    // Memoized in the registry.
    expect(reg.get("UserInput")).toBe(obj);
  });

  test("registry dedup — second call returns the same input object", () => {
    const Input = Schema.Struct({ x: Schema.String }).annotate({ identifier: "Dedup" });
    const reg = newRegistry();
    const a = schemaToInputType(Input, reg);
    const b = schemaToInputType(Input, reg);
    expect(a).toBe(b);
  });

  test("Schema.NullOr(T) → unwraps to T (input nullability is caller's concern)", () => {
    const out = schemaToInputType(Schema.NullOr(Schema.String), newRegistry());
    expect(out).toBe(GraphQLString);
  });

  test("brand passes through to underlying type", () => {
    const UserId = Schema.String.pipe(Schema.brand("UserId"));
    expect(schemaToInputType(UserId, newRegistry())).toBe(GraphQLString);
  });

  test("Schema.Array(T) → GraphQLList(T)", () => {
    const out = schemaToInputType(Schema.Array(Schema.String), newRegistry());
    expect(out).toBeInstanceOf(GraphQLList);
    expect((out as GraphQLList<typeof GraphQLString>).ofType).toBe(GraphQLString);
  });

  test("non-discriminator Union (String | Number) is rejected with a clear error", () => {
    const U = Schema.Union([Schema.String, Schema.Number]);
    expect(() => schemaToInputType(U, newRegistry())).toThrow(
      /GraphQL has no input union type/,
    );
  });

  test("recursive struct via Schema.suspend lowers without infinite recursion", () => {
    interface Tree {
      readonly name: string;
      readonly children: ReadonlyArray<Tree>;
    }
    const Tree: Schema.Codec<Tree> = Schema.Struct({
      name: Schema.String,
      children: Schema.Array(Schema.suspend((): Schema.Codec<Tree> => Tree)),
    }).annotate({ identifier: "Tree" });

    const reg = newRegistry();
    const out = schemaToInputType(Tree, reg);
    expect(out).toBeInstanceOf(GraphQLInputObjectType);
    const obj = out as GraphQLInputObjectType;
    expect(obj.name).toBe("Tree");
    const fields = obj.getFields();
    expect(fields.name!.type).toBe(GraphQLString);
    // The children field is a list of the same input type.
    const childrenType = fields.children!.type as GraphQLList<GraphQLInputObjectType>;
    expect(childrenType).toBeInstanceOf(GraphQLList);
    expect(childrenType.ofType).toBe(obj);
  });

  test("nested struct without identifier → throws", () => {
    const Outer = Schema.Struct({
      inner: Schema.Struct({ x: Schema.String }),
    }).annotate({ identifier: "Outer" });
    expect(() => {
      const t = schemaToInputType(Outer, newRegistry()) as GraphQLInputObjectType;
      // fields are thunked, so force resolution
      t.getFields();
    }).toThrow(/identifier annotation/);
  });
});

describe("schemaToScalar", () => {
  test("string codec roundtrip via parseValue / serialize / parseLiteral", () => {
    const DateFromString = Schema.declare<Date>((u): u is Date => u instanceof Date).pipe(
      Schema.encodeTo(Schema.String, {
        decode: SchemaGetter.transform((s: string) => new Date(s)),
        encode: SchemaGetter.transform((d: Date) => d.toISOString()),
      }),
    );
    const DateScalar = schemaToScalar(
      "Date",
      DateFromString as unknown as Schema.Codec<Date, string, never, never>,
    );
    expect(DateScalar).toBeInstanceOf(GraphQLScalarType);
    expect(DateScalar.name).toBe("Date");

    const iso = "2025-01-01T00:00:00.000Z";
    const decoded = DateScalar.parseValue(iso) as Date;
    expect(decoded).toBeInstanceOf(Date);
    expect(decoded.toISOString()).toBe(iso);

    const serialized = DateScalar.serialize(new Date(iso));
    expect(serialized).toBe(iso);

    const literal: ValueNode = { kind: Kind.STRING, value: iso };
    const fromLiteral = DateScalar.parseLiteral(literal) as Date;
    expect(fromLiteral.toISOString()).toBe(iso);
  });

  test("invalid input throws via Schema.decodeUnknownSync", () => {
    const PositiveNumber = Schema.Number.pipe(
      Schema.refine((n): n is number => n >= 0),
    );
    const PositiveScalar = schemaToScalar(
      "PositiveNumber",
      PositiveNumber as unknown as Schema.Codec<number, number, never, never>,
    );
    expect(() => PositiveScalar.parseValue(-1)).toThrow();
    expect(PositiveScalar.parseValue(5)).toBe(5);

    const literal: ValueNode = { kind: Kind.INT, value: "42" };
    expect(PositiveScalar.parseLiteral(literal)).toBe(42);
  });
});
