import { expect, test } from "bun:test";
import { Effect } from "effect";

import {
  GraphQLRuntimeTypeError,
  GraphQLSyntaxError,
  isGraphQLError,
} from "./graph-ql-error.ts";
import { Source } from "../language/source.ts";

test("specific GraphQL errors are real tagged errors", async () => {
  const result = await Effect.runPromise(
    Effect.fail(
      new GraphQLRuntimeTypeError("bad runtime type", {
        reason: "testRuntimeType",
      }),
    ).pipe(
      Effect.catchTag("GraphQLRuntimeTypeError", (error) =>
        Effect.succeed({ tag: error._tag, reason: error.reason }),
      ),
    ),
  );

  expect(result).toEqual({
    tag: "GraphQLRuntimeTypeError",
    reason: "testRuntimeType",
  });
});

test("GraphQL error JSON remains spec-shaped", () => {
  const error = new GraphQLSyntaxError(new Source("query {"), 7, "Expected Name");

  expect(isGraphQLError(error)).toBe(true);
  expect(error._tag).toBe("GraphQLSyntaxError");
  expect(JSON.parse(JSON.stringify(error))).toEqual({
    message: "Syntax Error: Expected Name",
    locations: [{ line: 1, column: 8 }],
  });
});
