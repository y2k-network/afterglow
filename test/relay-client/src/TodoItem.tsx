/**
 * Sanity fragment that exercises the bread-and-butter Relay client directives:
 *
 *   - `@required(action: THROW)` — bubbles up a runtime error if the marked
 *     field is null. relay-compiler validates that the directive is declared
 *     on the schema (we declare it in `relayDirectives()`).
 *   - `@throwOnFieldError` on the fragment — opts into Relay's modern error
 *     handling. Combined with our SDL's `@semanticNonNull` annotations on
 *     non-nullable Effect Schema fields, this is what lifts wire-nullable
 *     fields to non-null TS types in the generated artifact.
 *   - `@catch(to: NULL)` — opt out of throw-on-error per-field, surfacing
 *     the value as `null` instead.
 *
 * Source: relay.dev "GraphQL & Directives" reference,
 *   https://relay.dev/docs/api-reference/graphql-and-directives/
 *   https://relay.dev/docs/guides/throw-on-field-error-directive/
 *   https://relay.dev/docs/guides/required-directive/
 *   https://relay.dev/docs/guides/catch-directive/
 */
import * as React from "react";
import { graphql, useFragment } from "react-relay";
import type { TodoItem_todo$key } from "./__generated__/TodoItem_todo.graphql";

interface Props {
  readonly todo: TodoItem_todo$key;
}

export function TodoItem({ todo }: Props): React.ReactElement {
  const data = useFragment(
    graphql`
      fragment TodoItem_todo on Todo @throwOnFieldError {
        id
        title @required(action: THROW)
        completed
        createdAt @catch(to: NULL)
      }
    `,
    todo,
  );
  return (
    <li>
      <span>{data.title}</span>
      <span>{data.completed ? "done" : "pending"}</span>
    </li>
  );
}
