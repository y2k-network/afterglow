/**
 * Exercises `@inline` (readable outside React render) and `@no_inline`
 * (forces NOT to be inlined into parent operation).
 *
 * Source:
 *   https://relay.dev/docs/api-reference/graphql-and-directives/#inline
 */
import { graphql } from "react-relay";

export const TodoTitleInlineFragment = graphql`
  fragment InlineHelpers_title on Todo @inline {
    title
  }
`;

export const TodoCompletedNoInlineFragment = graphql`
  fragment InlineHelpers_completed on Todo @no_inline {
    completed
  }
`;
