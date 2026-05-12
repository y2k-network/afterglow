import { Effect } from "effect";
import { describe, expect, test as it } from "bun:test";

import { graphql } from "../../graphql.ts";
import { execute } from "../../execution/execute.ts";
import { parse } from "../../language/parser.ts";
import { buildSchema } from "../../utilities/build-ast-schema.ts";
import { getIntrospectionQuery } from "../../utilities/get-introspection-query.ts";
import { graphqlSync } from "./graphql-corpus-harness.ts";

function dataFor(schemaSource: string, source: string) {
  return graphqlSync({ schema: buildSchema(schemaSource), source });
}

describe("Introspection", () => {
  it("executes an introspection query", () => {
    const schema = buildSchema(`
      type SomeObject {
        someField: String
      }

      schema {
        query: SomeObject
      }
    `);

    const result = Effect.runSync(graphql({
      schema,
      source: getIntrospectionQuery({
        descriptions: false,
        specifiedByUrl: true,
        directiveIsRepeatable: true,
      }),
    }));

    expect(result.data).toMatchObject({
      __schema: {
        queryType: { name: "SomeObject", kind: "OBJECT" },
        mutationType: null,
        subscriptionType: null,
      },
    });
    expect((result.data as any).__schema.types).toContainEqual({
      kind: "OBJECT",
      name: "SomeObject",
      specifiedByURL: null,
      fields: [
        {
          name: "someField",
          args: [],
          type: { kind: "SCALAR", name: "String", ofType: null },
          isDeprecated: false,
          deprecationReason: null,
        },
      ],
      inputFields: null,
      interfaces: [],
      enumValues: null,
      possibleTypes: null,
    });
  });

  it("introspects on input object", () => {
    expect(dataFor(`
      input SomeInputObject {
        a: String = "tes\\t de\\fault"
        b: [String]
        c: String = null
      }
      type Query { someField(someArg: SomeInputObject): String }
    `, `
      {
        __type(name: "SomeInputObject") {
          kind
          name
          inputFields { name type { kind name ofType { kind name } } defaultValue }
        }
      }
    `)).toEqual({
      data: {
        __type: {
          kind: "INPUT_OBJECT",
          name: "SomeInputObject",
          inputFields: [
            { name: "a", type: { kind: "SCALAR", name: "String", ofType: null }, defaultValue: '"tes\\t de\\fault"' },
            { name: "b", type: { kind: "LIST", name: null, ofType: { kind: "SCALAR", name: "String" } }, defaultValue: null },
            { name: "c", type: { kind: "SCALAR", name: "String", ofType: null }, defaultValue: "null" },
          ],
        },
      },
    });
  });

  it("introspects any default value", () => {
    expect(dataFor(`
      input InputObjectWithDefaultValues {
        a: String = "Emoji: \\u{1F600}"
        b: Complex = {x: ["abc"], y: 123}
      }
      input Complex { x: [String] y: Int }
      type Query { someField(someArg: InputObjectWithDefaultValues): String }
    `, `
      { __type(name: "InputObjectWithDefaultValues") { inputFields { name defaultValue } } }
    `)).toEqual({
      data: {
        __type: {
          inputFields: [
            { name: "a", defaultValue: '"Emoji: 😀"' },
            { name: "b", defaultValue: '{x: ["abc"], y: 123}' },
          ],
        },
      },
    });
  });

  it("supports the __type root field", () => {
    expect(dataFor(`type Query { someField: String }`, `{ __type(name: "Query") { name } }`)).toEqual({
      data: { __type: { name: "Query" } },
    });
  });

  it("identifies deprecated fields", () => {
    expect(dataFor(`
      type Query {
        nonDeprecated: String
        deprecated: String @deprecated(reason: "Removed in 1.0")
        deprecatedWithEmptyReason: String @deprecated(reason: "")
      }
    `, `{ __type(name: "Query") { fields(includeDeprecated: true) { name isDeprecated deprecationReason } } }`)).toEqual({
      data: {
        __type: {
          fields: [
            { name: "nonDeprecated", isDeprecated: false, deprecationReason: null },
            { name: "deprecated", isDeprecated: true, deprecationReason: "Removed in 1.0" },
            { name: "deprecatedWithEmptyReason", isDeprecated: true, deprecationReason: "" },
          ],
        },
      },
    });
  });

  it("respects the includeDeprecated parameter for fields", () => {
    expect(dataFor(`
      type Query {
        nonDeprecated: String
        deprecated: String @deprecated(reason: "Removed in 1.0")
      }
    `, `
      { __type(name: "Query") { trueFields: fields(includeDeprecated: true) { name } falseFields: fields(includeDeprecated: false) { name } omittedFields: fields { name } } }
    `)).toEqual({
      data: {
        __type: {
          trueFields: [{ name: "nonDeprecated" }, { name: "deprecated" }],
          falseFields: [{ name: "nonDeprecated" }],
          omittedFields: [{ name: "nonDeprecated" }],
        },
      },
    });
  });

  it("identifies deprecated args", () => {
    expect(dataFor(`
      type Query {
        someField(nonDeprecated: String, deprecated: String @deprecated(reason: "Removed in 1.0"), deprecatedWithEmptyReason: String @deprecated(reason: "")): String
      }
    `, `{ __type(name: "Query") { fields { args(includeDeprecated: true) { name isDeprecated deprecationReason } } } }`)).toEqual({
      data: {
        __type: {
          fields: [{ args: [
            { name: "nonDeprecated", isDeprecated: false, deprecationReason: null },
            { name: "deprecated", isDeprecated: true, deprecationReason: "Removed in 1.0" },
            { name: "deprecatedWithEmptyReason", isDeprecated: true, deprecationReason: "" },
          ] }],
        },
      },
    });
  });

  it("respects the includeDeprecated parameter for args", () => {
    expect(dataFor(`
      type Query { someField(nonDeprecated: String, deprecated: String @deprecated(reason: "Removed in 1.0")): String }
    `, `{ __type(name: "Query") { fields { trueArgs: args(includeDeprecated: true) { name } falseArgs: args(includeDeprecated: false) { name } omittedArgs: args { name } } } }`)).toEqual({
      data: {
        __type: { fields: [{ trueArgs: [{ name: "nonDeprecated" }, { name: "deprecated" }], falseArgs: [{ name: "nonDeprecated" }], omittedArgs: [{ name: "nonDeprecated" }] }] },
      },
    });
  });

  it("identifies deprecated enum values", () => {
    expect(dataFor(`
      enum SomeEnum { NON_DEPRECATED DEPRECATED @deprecated(reason: "Removed in 1.0") ALSO_NON_DEPRECATED }
      type Query { someField(someArg: SomeEnum): String }
    `, `{ __type(name: "SomeEnum") { enumValues(includeDeprecated: true) { name isDeprecated deprecationReason } } }`)).toEqual({
      data: {
        __type: {
          enumValues: [
            { name: "NON_DEPRECATED", isDeprecated: false, deprecationReason: null },
            { name: "DEPRECATED", isDeprecated: true, deprecationReason: "Removed in 1.0" },
            { name: "ALSO_NON_DEPRECATED", isDeprecated: false, deprecationReason: null },
          ],
        },
      },
    });
  });

  it("respects the includeDeprecated parameter for enum values", () => {
    expect(dataFor(`
      enum SomeEnum { NON_DEPRECATED DEPRECATED @deprecated(reason: "Removed in 1.0") DEPRECATED_WITH_EMPTY_REASON @deprecated(reason: "") ALSO_NON_DEPRECATED }
      type Query { someField(someArg: SomeEnum): String }
    `, `{ __type(name: "SomeEnum") { trueValues: enumValues(includeDeprecated: true) { name } falseValues: enumValues(includeDeprecated: false) { name } omittedValues: enumValues { name } } }`)).toEqual({
      data: {
        __type: {
          trueValues: [{ name: "NON_DEPRECATED" }, { name: "DEPRECATED" }, { name: "DEPRECATED_WITH_EMPTY_REASON" }, { name: "ALSO_NON_DEPRECATED" }],
          falseValues: [{ name: "NON_DEPRECATED" }, { name: "ALSO_NON_DEPRECATED" }],
          omittedValues: [{ name: "NON_DEPRECATED" }, { name: "ALSO_NON_DEPRECATED" }],
        },
      },
    });
  });

  it("identifies deprecated for input fields", () => {
    expect(dataFor(`
      input SomeInputObject { nonDeprecated: String deprecated: String @deprecated(reason: "Removed in 1.0") deprecatedWithEmptyReason: String @deprecated(reason: "") }
      type Query { someField(someArg: SomeInputObject): String }
    `, `{ __type(name: "SomeInputObject") { inputFields(includeDeprecated: true) { name isDeprecated deprecationReason } } }`)).toEqual({
      data: {
        __type: {
          inputFields: [
            { name: "nonDeprecated", isDeprecated: false, deprecationReason: null },
            { name: "deprecated", isDeprecated: true, deprecationReason: "Removed in 1.0" },
            { name: "deprecatedWithEmptyReason", isDeprecated: true, deprecationReason: "" },
          ],
        },
      },
    });
  });

  it("respects the includeDeprecated parameter for input fields", () => {
    expect(dataFor(`
      input SomeInputObject { nonDeprecated: String deprecated: String @deprecated(reason: "Removed in 1.0") }
      type Query { someField(someArg: SomeInputObject): String }
    `, `{ __type(name: "SomeInputObject") { trueFields: inputFields(includeDeprecated: true) { name } falseFields: inputFields(includeDeprecated: false) { name } omittedFields: inputFields { name } } }`)).toEqual({
      data: {
        __type: {
          trueFields: [{ name: "nonDeprecated" }, { name: "deprecated" }],
          falseFields: [{ name: "nonDeprecated" }],
          omittedFields: [{ name: "nonDeprecated" }],
        },
      },
    });
  });

  it("identifies oneOf for input objects", () => {
    expect(dataFor(`
      input SomeInputObject @oneOf { a: String }
      input AnotherInputObject { a: String b: String }
      type Query { someField(someArg: SomeInputObject): String anotherField(anotherArg: AnotherInputObject): String }
    `, `{ oneOfInputObject: __type(name: "SomeInputObject") { isOneOf } inputObject: __type(name: "AnotherInputObject") { isOneOf } }`)).toEqual({
      data: { oneOfInputObject: { isOneOf: true }, inputObject: { isOneOf: false } },
    });
  });

  it("returns null for oneOf for other types", () => {
    expect(dataFor(`
      type SomeObject implements SomeInterface { fieldA: String }
      enum SomeEnum { SomeObject }
      interface SomeInterface { fieldA: String }
      union SomeUnion = SomeObject
      type Query { someField(enum: SomeEnum): SomeUnion anotherField(enum: SomeEnum): SomeInterface }
    `, `{ object: __type(name: "SomeObject") { isOneOf } enum: __type(name: "SomeEnum") { isOneOf } interface: __type(name: "SomeInterface") { isOneOf } scalar: __type(name: "String") { isOneOf } union: __type(name: "SomeUnion") { isOneOf } }`)).toEqual({
      data: {
        object: { isOneOf: null },
        enum: { isOneOf: null },
        interface: { isOneOf: null },
        scalar: { isOneOf: null },
        union: { isOneOf: null },
      },
    });
  });

  it("fails as expected on the __type root field without an arg", () => {
    expect(JSON.parse(JSON.stringify(dataFor(`type Query { someField: String }`, `{ __type { name } }`)))).toEqual({
      errors: [
        {
          message: 'Field "__type" argument "name" of type "String!" is required, but it was not provided.',
          locations: [{ line: 1, column: 3 }],
        },
      ],
    });
  });

  it("exposes descriptions", () => {
    expect(dataFor(`
      """Enum description"""
      enum SomeEnum { """Value description""" VALUE }
      """Object description"""
      type SomeObject { """Field description""" someField(arg: SomeEnum): String }
      """Schema description"""
      schema { query: SomeObject }
    `, `{ Schema: __schema { description } SomeObject: __type(name: "SomeObject") { description fields { name description } } SomeEnum: __type(name: "SomeEnum") { description enumValues { name description } } }`)).toEqual({
      data: {
        Schema: { description: "Schema description" },
        SomeObject: { description: "Object description", fields: [{ name: "someField", description: "Field description" }] },
        SomeEnum: { description: "Enum description", enumValues: [{ name: "VALUE", description: "Value description" }] },
      },
    });
  });

  it("executes an introspection query without calling global resolvers", () => {
    const schema = buildSchema(`type Query { someField: String }`);
    const result = Effect.runSync(execute({
      schema,
      document: parse(getIntrospectionQuery({ specifiedByUrl: true, directiveIsRepeatable: true, schemaDescription: true })),
      fieldResolver: (_source, _args, _context, info) => {
        throw new Error(`Called on ${info.parentType.name}::${info.fieldName}`);
      },
      typeResolver: (_value, _context, info) => {
        throw new Error(`Called on ${info.parentType.name}::${info.fieldName}`);
      },
    }));
    expect(result.errors).toBeUndefined();
    expect(result.data).toBeDefined();
  });
});
