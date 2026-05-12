import { isGraphQLError } from "../alembic-graphql/error/graph-ql-error.ts";

export function graphqlErrorJSON(err: unknown): Record<string, unknown> {
  if (isGraphQLError(err)) {
    return err.toJSON() as unknown as Record<string, unknown>;
  }
  if (err instanceof Error) return { message: err.message };
  return { message: String(err) };
}
