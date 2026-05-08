/**
 * Refetchable fragment on Viewer (covers `@refetchable` on a non-Node parent
 * — Relay docs explicitly call out Query, Viewer, or Node-implementing types
 * as valid `@refetchable` parents).
 *
 * Source:
 *   https://relay.dev/docs/api-reference/use-refetchable-fragment/
 */
import * as React from "react";
import { graphql, useRefetchableFragment } from "react-relay";
import type { RefetchableViewer_viewer$key } from "./__generated__/RefetchableViewer_viewer.graphql";

interface Props {
  readonly viewer: RefetchableViewer_viewer$key;
}

export function RefetchableViewer({ viewer }: Props): React.ReactElement {
  const [data, refetch] = useRefetchableFragment(
    graphql`
      fragment RefetchableViewer_viewer on Viewer
        @refetchable(queryName: "RefetchableViewerQuery")
        @throwOnFieldError {
        user {
          id
        }
      }
    `,
    viewer,
  );
  return (
    <div>
      <span>user: {data.user?.id ?? "(no user)"}</span>
      <button type="button" onClick={() => refetch({})}>
        refresh
      </button>
    </div>
  );
}
