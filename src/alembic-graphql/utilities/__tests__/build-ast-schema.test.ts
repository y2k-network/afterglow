import { Effect } from "effect";
import { describe, expect, test as it } from "bun:test";

import { dedent } from "../../__testUtils__/dedent.ts";
import { graphql } from "../../graphql.ts";
import { parse } from "../../language/parser.ts";
import { assertEnumType, assertInputObjectType, assertObjectType, assertScalarType } from "../../type/definition.ts";
import {
  GraphQLDeprecatedDirective,
  GraphQLIncludeDirective,
  GraphQLOneOfDirective,
  GraphQLSkipDirective,
  GraphQLSpecifiedByDirective,
} from "../../type/directives.ts";
import { GraphQLBoolean, GraphQLFloat, GraphQLID, GraphQLInt, GraphQLString } from "../../type/scalars.ts";
import { GraphQLSchema } from "../../type/schema.ts";
import { validateSchema } from "../../type/validate.ts";
import { buildASTSchema, buildSchema } from "../build-ast-schema.ts";
import { printSchema } from "../print-schema.ts";

function cycleSDL(sdl: string): string {
  return printSchema(buildSchema(sdl));
}

describe("Schema Builder", () => {
  it("can use built schema for limited execution", () => {
    const schema = buildASTSchema(parse(`type Query { str: String }`));
    const result = Effect.runSync(graphql({ schema, source: `{ str }`, rootValue: { str: 123 } }));
    expect(result.data).toEqual({ str: "123" });
  });

  it("can build a schema directly from the source", () => {
    const schema = buildSchema(`type Query { add(x: Int, y: Int): Int }`);
    const result = Effect.runSync(graphql({
      schema,
      source: `{ add(x: 34, y: 55) }`,
      rootValue: { add: ({ x, y }: { x: number; y: number }) => x + y },
    }));
    expect(result).toEqual({ data: { add: 89 } });
  });

  it("ignores non-type system definitions", () => {
    expect(() => buildSchema(`type Query { str: String } fragment SomeFragment on Query { str }`)).not.toThrow();
  });

  it("prints simple SDL cycles", () => {
    const sdl = dedent`
      type Query {
        str: String
        int: Int
      }
    `;
    expect(printSchema(buildSchema(sdl))).toBe(sdl);
    const schema = buildSchema(sdl);
    expect(schema.getType("String")).toBe(GraphQLString);
    expect(schema.getType("Int")).toBe(GraphQLInt);
    expect(validateSchema(schema)).toEqual([]);
  });

  it("Match order of default types and directives", () => {
    const schema = new GraphQLSchema({});
    const sdlSchema = buildASTSchema({ kind: "Document", definitions: [] });
    expect(sdlSchema.getDirectives()).toEqual(schema.getDirectives());
    expect(sdlSchema.getTypeMap()).toEqual(schema.getTypeMap());
    expect(Object.keys(sdlSchema.getTypeMap())).toEqual(Object.keys(schema.getTypeMap()));
  });

  it("Empty type", () => {
    const sdl = dedent`
      type EmptyType
    `;
    expect(cycleSDL(sdl)).toBe(sdl);
  });

  it("Simple type", () => {
    const sdl = dedent`
      type Query {
        str: String
        int: Int
        float: Float
        id: ID
        bool: Boolean
      }
    `;
    expect(cycleSDL(sdl)).toBe(sdl);
    const schema = buildSchema(sdl);
    expect(schema.getType("Int")).toBe(GraphQLInt);
    expect(schema.getType("Float")).toBe(GraphQLFloat);
    expect(schema.getType("String")).toBe(GraphQLString);
    expect(schema.getType("Boolean")).toBe(GraphQLBoolean);
    expect(schema.getType("ID")).toBe(GraphQLID);
  });

  it("include standard type only if it is used", () => {
    const schema = buildSchema("type Query");
    expect(schema.getType("Int")).toBeUndefined();
    expect(schema.getType("Float")).toBeUndefined();
    expect(schema.getType("ID")).toBeUndefined();
  });

  it("With directives", () => {
    const sdl = dedent`
      directive @foo(arg: Int) on FIELD

      directive @repeatableFoo(arg: Int) repeatable on FIELD
    `;
    expect(cycleSDL(sdl)).toBe(sdl);
  });

  it("Supports descriptions", () => {
    const sdl = dedent`
      """Do you agree that this is the most creative schema ever?"""
      schema {
        query: Query
      }

      """This is a directive"""
      directive @foo(
        """It has an argument"""
        arg: Int
      ) on FIELD

      """Who knows what inside this scalar?"""
      scalar MysteryScalar

      """This is a input object type"""
      input FooInput {
        """It has a field"""
        field: Int
      }

      """This is a interface type"""
      interface Energy {
        """It also has a field"""
        str: String
      }

      """There is nothing inside!"""
      union BlackHole

      """With an enum"""
      enum Color {
        RED

        """Not a creative color"""
        GREEN
        BLUE
      }

      """What a great type"""
      type Query {
        """And a field to boot"""
        str: String
      }
    `;
    expect(cycleSDL(sdl)).toBe(sdl);
  });

  it("Maintains @include, @skip & @specifiedBy", () => {
    const schema = buildSchema("type Query");
    expect(schema.getDirectives()).toHaveLength(5);
    expect(schema.getDirective("skip")).toBe(GraphQLSkipDirective);
    expect(schema.getDirective("include")).toBe(GraphQLIncludeDirective);
    expect(schema.getDirective("deprecated")).toBe(GraphQLDeprecatedDirective);
    expect(schema.getDirective("specifiedBy")).toBe(GraphQLSpecifiedByDirective);
    expect(schema.getDirective("oneOf")).toBe(GraphQLOneOfDirective);
  });

  it("Overriding directives excludes specified", () => {
    const schema = buildSchema(`
      directive @skip on FIELD
      directive @include on FIELD
      directive @deprecated on FIELD_DEFINITION
      directive @specifiedBy on FIELD_DEFINITION
      directive @oneOf on OBJECT
    `);
    expect(schema.getDirectives()).toHaveLength(5);
    expect(schema.getDirective("skip")).not.toBe(GraphQLSkipDirective);
    expect(schema.getDirective("include")).not.toBe(GraphQLIncludeDirective);
    expect(schema.getDirective("deprecated")).not.toBe(GraphQLDeprecatedDirective);
    expect(schema.getDirective("specifiedBy")).not.toBe(GraphQLSpecifiedByDirective);
    expect(schema.getDirective("oneOf")).not.toBe(GraphQLOneOfDirective);
  });

  it("Adding directives maintains @include, @skip, @deprecated, @specifiedBy, and @oneOf", () => {
    const schema = buildSchema(`directive @foo(arg: Int) on FIELD`);
    expect(schema.getDirectives()).toHaveLength(6);
    expect(schema.getDirective("skip")).toBeDefined();
    expect(schema.getDirective("include")).toBeDefined();
    expect(schema.getDirective("deprecated")).toBeDefined();
    expect(schema.getDirective("specifiedBy")).toBeDefined();
    expect(schema.getDirective("oneOf")).toBeDefined();
  });

  it("Type modifiers", () => {
    const sdl = dedent`
      type Query {
        nonNullStr: String!
        listOfStrings: [String]
        listOfNonNullStrings: [String!]
        nonNullListOfStrings: [String]!
        nonNullListOfNonNullStrings: [String!]!
      }
    `;
    expect(cycleSDL(sdl)).toBe(sdl);
  });

  it("Recursive type", () => {
    const sdl = dedent`
      type Query {
        str: String
        recurse: Query
      }
    `;
    expect(cycleSDL(sdl)).toBe(sdl);
  });

  it("Two types circular", () => {
    const sdl = dedent`
      type TypeOne {
        str: String
        typeTwo: TypeTwo
      }

      type TypeTwo {
        str: String
        typeOne: TypeOne
      }
    `;
    expect(cycleSDL(sdl)).toBe(sdl);
  });

  it("Single argument field", () => {
    const sdl = dedent`
      type Query {
        str(int: Int): String
        floatToStr(float: Float): String
        idToStr(id: ID): String
        booleanToStr(bool: Boolean): String
        strToStr(bool: String): String
      }
    `;
    expect(cycleSDL(sdl)).toBe(sdl);
  });

  it("Simple type with multiple arguments", () => {
    const sdl = dedent`
      type Query {
        str(int: Int, bool: Boolean): String
      }
    `;
    expect(cycleSDL(sdl)).toBe(sdl);
  });

  it("Empty interface", () => {
    const sdl = dedent`
      interface EmptyInterface
    `;
    const definition = parse(sdl).definitions[0];
    expect(definition.kind === "InterfaceTypeDefinition" ? definition.interfaces : null).toEqual([]);
    expect(cycleSDL(sdl)).toBe(sdl);
  });

  it("Simple type with interface", () => {
    const sdl = dedent`
      type Query implements WorldInterface {
        str: String
      }

      interface WorldInterface {
        str: String
      }
    `;
    expect(cycleSDL(sdl)).toBe(sdl);
  });

  it("Simple interface hierarchy", () => {
    const sdl = dedent`
      schema {
        query: Child
      }

      interface Child implements Parent {
        str: String
      }

      type Hello implements Parent & Child {
        str: String
      }

      interface Parent {
        str: String
      }
    `;
    expect(cycleSDL(sdl)).toBe(sdl);
  });

  it("Empty enum", () => {
    const sdl = dedent`
      enum EmptyEnum
    `;
    expect(cycleSDL(sdl)).toBe(sdl);
  });

  it("Simple output enum", () => {
    const sdl = dedent`
      enum Hello {
        WORLD
      }

      type Query {
        hello: Hello
      }
    `;
    expect(cycleSDL(sdl)).toBe(sdl);
  });

  it("Simple input enum", () => {
    const sdl = dedent`
      enum Hello {
        WORLD
      }

      type Query {
        str(hello: Hello): String
      }
    `;
    expect(cycleSDL(sdl)).toBe(sdl);
  });

  it("Multiple value enum", () => {
    const sdl = dedent`
      enum Hello {
        WO
        RLD
      }

      type Query {
        hello: Hello
      }
    `;
    expect(cycleSDL(sdl)).toBe(sdl);
  });

  it("Empty union", () => {
    const sdl = dedent`
      union EmptyUnion
    `;
    expect(cycleSDL(sdl)).toBe(sdl);
  });

  it("Simple Union", () => {
    const sdl = dedent`
      union Hello = World

      type Query {
        hello: Hello
      }

      type World {
        str: String
      }
    `;
    expect(cycleSDL(sdl)).toBe(sdl);
  });

  it("Multiple Union", () => {
    const sdl = dedent`
      union Hello = WorldOne | WorldTwo

      type Query {
        hello: Hello
      }

      type WorldOne {
        str: String
      }

      type WorldTwo {
        str: String
      }
    `;
    expect(cycleSDL(sdl)).toBe(sdl);
  });

  it("Can build recursive Union", () => {
    const schema = buildSchema(`
      union Hello = Hello

      type Query {
        hello: Hello
      }
    `);
    expect(validateSchema(schema).length).toBeGreaterThan(0);
  });

  it("Custom Scalar", () => {
    const sdl = dedent`
      scalar CustomScalar

      type Query {
        customScalar: CustomScalar
      }
    `;
    expect(cycleSDL(sdl)).toBe(sdl);
  });

  it("Empty Input Object", () => {
    const sdl = dedent`
      input EmptyInputObject
    `;
    expect(cycleSDL(sdl)).toBe(sdl);
  });

  it("Simple Input Object", () => {
    const sdl = dedent`
      input Input {
        int: Int
      }

      type Query {
        field(in: Input): String
      }
    `;
    expect(cycleSDL(sdl)).toBe(sdl);
  });

  it("Simple argument field with default", () => {
    const sdl = dedent`
      type Query {
        str(int: Int = 2): String
      }
    `;
    expect(cycleSDL(sdl)).toBe(sdl);
  });

  it("Custom scalar argument field with default", () => {
    const sdl = dedent`
      scalar CustomScalar

      type Query {
        str(int: CustomScalar = 2): String
      }
    `;
    expect(cycleSDL(sdl)).toBe(sdl);
  });

  it("Simple type with mutation", () => {
    const sdl = dedent`
      schema {
        query: HelloScalars
        mutation: Mutation
      }

      type HelloScalars {
        str: String
        int: Int
        bool: Boolean
      }

      type Mutation {
        addHelloScalars(str: String, int: Int, bool: Boolean): HelloScalars
      }
    `;
    expect(cycleSDL(sdl)).toBe(sdl);
  });

  it("Simple type with subscription", () => {
    const sdl = dedent`
      schema {
        query: HelloScalars
        subscription: Subscription
      }

      type HelloScalars {
        str: String
        int: Int
        bool: Boolean
      }

      type Subscription {
        subscribeHelloScalars(str: String, int: Int, bool: Boolean): HelloScalars
      }
    `;
    expect(cycleSDL(sdl)).toBe(sdl);
  });

  it("Unreferenced type implementing referenced interface", () => {
    const sdl = dedent`
      type Concrete implements Interface {
        key: String
      }

      interface Interface {
        key: String
      }

      type Query {
        interface: Interface
      }
    `;
    expect(cycleSDL(sdl)).toBe(sdl);
  });

  it("Unreferenced interface implementing referenced interface", () => {
    const sdl = dedent`
      interface Child implements Parent {
        key: String
      }

      interface Parent {
        key: String
      }

      type Query {
        interfaceField: Parent
      }
    `;
    expect(cycleSDL(sdl)).toBe(sdl);
  });

  it("Unreferenced type implementing referenced union", () => {
    const sdl = dedent`
      type Concrete {
        key: String
      }

      type Query {
        union: Union
      }

      union Union = Concrete
    `;
    expect(cycleSDL(sdl)).toBe(sdl);
  });

  it("Supports @deprecated", () => {
    const sdl = dedent`
      enum MyEnum {
        VALUE
        OLD_VALUE @deprecated
        OTHER_VALUE @deprecated(reason: "Terrible reasons")
      }

      input MyInput {
        oldInput: String @deprecated
        otherInput: String @deprecated(reason: "Use newInput")
        newInput: String
      }

      type Query {
        field1: String @deprecated
        field2: Int @deprecated(reason: "Because I said so")
        enum: MyEnum
        field3(oldArg: String @deprecated, arg: String): String
        field4(oldArg: String @deprecated(reason: "Why not?"), arg: String): String
        field5(arg: MyInput): String
      }
    `;
    expect(cycleSDL(sdl)).toBe(sdl);

    const schema = buildSchema(sdl);
    const myEnum = assertEnumType(schema.getType("MyEnum"));
    expect(myEnum.getValue("VALUE")?.deprecationReason).toBeUndefined();
    expect(myEnum.getValue("OLD_VALUE")?.deprecationReason).toBe("No longer supported");
    expect(myEnum.getValue("OTHER_VALUE")?.deprecationReason).toBe("Terrible reasons");

    const rootFields = assertObjectType(schema.getType("Query")).getFields();
    expect(rootFields.field1.deprecationReason).toBe("No longer supported");
    expect(rootFields.field2.deprecationReason).toBe("Because I said so");
    expect(rootFields.field3.args[0]?.deprecationReason).toBe("No longer supported");
    expect(rootFields.field4.args[0]?.deprecationReason).toBe("Why not?");

    const inputFields = assertInputObjectType(schema.getType("MyInput")).getFields();
    expect(inputFields.newInput.deprecationReason).toBeUndefined();
    expect(inputFields.oldInput.deprecationReason).toBe("No longer supported");
    expect(inputFields.otherInput.deprecationReason).toBe("Use newInput");
  });

  it("Supports @specifiedBy", () => {
    const sdl = dedent`
      scalar Foo @specifiedBy(url: "https://example.com/foo_spec")

      type Query {
        foo: Foo @deprecated
      }
    `;
    expect(cycleSDL(sdl)).toBe(sdl);
    expect(assertScalarType(buildSchema(sdl).getType("Foo")).specifiedByURL).toBe("https://example.com/foo_spec");
  });
});
