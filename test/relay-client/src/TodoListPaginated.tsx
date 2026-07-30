/**
 * Pagination via `usePaginationFragment` against `Viewer.todos` — exercises
 * `@connection`, `@refetchable`, and `@argumentDefinitions` / `@arguments`.
 *
 * Source:
 *   https://relay.dev/docs/guided-tour/list-data/pagination/
 *   https://relay.dev/docs/api-reference/graphql-and-directives/#refetchable
 */
import * as React from "react";
import { graphql, usePaginationFragment } from "react-relay";
import type { TodoListPaginated_viewer$key } from "./__generated__/TodoListPaginated_viewer.graphql";

interface Props {
  readonly viewer: TodoListPaginated_viewer$key;
}

export function TodoListPaginated({ viewer }: Props): React.ReactElement {
  const { data, loadNext, hasNext, isLoadingNext } = usePaginationFragment(
    graphql`
      fragment TodoListPaginated_viewer on Viewer
        @argumentDefinitions(
          count: { type: "Int", defaultValue: 10 }
          cursor: { type: "String" }
        )
        @refetchable(queryName: "TodoListPaginatedRefetchQuery") {
        todos(first: $count, after: $cursor)
          @connection(key: "TodoListPaginated_todos") {
          edges {
            cursor
            node {
              id
              title
              completed
            }
          }
        }
      }
    `,
    viewer,
  );

  const edges = data.todos?.edges ?? [];
  return (
    <ul>
      {edges.map((edge) =>
        edge?.node ? (
          <li key={edge.node.id}>{edge.node.title ?? "(untitled)"}</li>
        ) : null,
      )}
      {hasNext ? (
        <button
          type="button"
          disabled={isLoadingNext}
          onClick={() => {
            loadNext(10);
          }}
        >
          Load more
        </button>
      ) : null}
    </ul>
  );
}
