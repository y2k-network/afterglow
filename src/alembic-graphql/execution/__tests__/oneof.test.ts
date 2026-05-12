import { describe, test as it } from "bun:test";

import { expectJSON } from "../../__test-utils__/expect-json.ts";

import { parse } from "../../language/parser.ts";

import { buildSchema } from "../../utilities/build-ast-schema.ts";

import type { ExecutionResult } from "./execute-corpus-harness.ts";
import { execute } from "./execute-corpus-harness.ts";

const schema = buildSchema(`
  type Query {
    test(input: TestInputObject!): TestObject
  }

  input TestInputObject @oneOf {
    a: String
    b: Int
  }

  type TestObject {
    a: String
    b: Int
  }
`);

function executeQuery(
  query: string,
  rootValue: unknown,
  variableValues?: { [variable: string]: unknown },
): ExecutionResult | Promise<ExecutionResult> {
  return execute({ schema, document: parse(query), rootValue, variableValues });
}

describe('Execute: Handles OneOf Input Objects', () => {
  describe('OneOf Input Objects', () => {
    const rootValue = {
      test({ input }: { input: { a?: string; b?: number } }) {
        return input;
      },
    };

    it('accepts a good default value', async () => {
      const query = `
        query ($input: TestInputObject! = {a: "abc"}) {
          test(input: $input) {
            a
            b
          }
        }
      `;
      const result = await executeQuery(query, rootValue);

      expectJSON(result).toDeepEqual({
        data: {
          test: {
            a: 'abc',
            b: null,
          },
        },
      });
    });

    it('rejects a bad default value', async () => {
      const query = `
        query ($input: TestInputObject! = {a: "abc", b: 123}) {
          test(input: $input) {
            a
            b
          }
        }
      `;
      const result = await executeQuery(query, rootValue);

      expectJSON(result).toDeepEqual({
        data: {
          test: null,
        },
        errors: [
          {
            locations: [{ column: 23, line: 3 }],
            message:
              // This type of error would be caught at validation-time
              // hence the vague error message here.
              'Argument "input" of non-null type "TestInputObject!" must not be null.',
            path: ['test'],
          },
        ],
      });
    });

    it('accepts a good variable', async () => {
      const query = `
        query ($input: TestInputObject!) {
          test(input: $input) {
            a
            b
          }
        }
      `;
      const result = await executeQuery(query, rootValue, { input: { a: 'abc' } });

      expectJSON(result).toDeepEqual({
        data: {
          test: {
            a: 'abc',
            b: null,
          },
        },
      });
    });

    it('accepts a good variable with an undefined key', async () => {
      const query = `
        query ($input: TestInputObject!) {
          test(input: $input) {
            a
            b
          }
        }
      `;
      const result = await executeQuery(query, rootValue, {
        input: { a: 'abc', b: undefined },
      });

      expectJSON(result).toDeepEqual({
        data: {
          test: {
            a: 'abc',
            b: null,
          },
        },
      });
    });

    it('rejects a variable with multiple non-null keys', async () => {
      const query = `
        query ($input: TestInputObject!) {
          test(input: $input) {
            a
            b
          }
        }
      `;
      const result = await executeQuery(query, rootValue, {
        input: { a: 'abc', b: 123 },
      });

      expectJSON(result).toDeepEqual({
        errors: [
          {
            locations: [{ column: 16, line: 2 }],
            message:
              'Variable "$input" got invalid value { a: "abc", b: 123 }; Exactly one key must be specified for OneOf type "TestInputObject".',
          },
        ],
      });
    });

    it('rejects a variable with multiple nullable keys', async () => {
      const query = `
        query ($input: TestInputObject!) {
          test(input: $input) {
            a
            b
          }
        }
      `;
      const result = await executeQuery(query, rootValue, {
        input: { a: 'abc', b: null },
      });

      expectJSON(result).toDeepEqual({
        errors: [
          {
            locations: [{ column: 16, line: 2 }],
            message:
              'Variable "$input" got invalid value { a: "abc", b: null }; Exactly one key must be specified for OneOf type "TestInputObject".',
          },
        ],
      });
    });
  });
});
