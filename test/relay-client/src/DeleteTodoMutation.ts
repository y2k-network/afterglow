/**
 * Mutation exercising `@deleteRecord` against the `deleteTodo` mutation field
 * which already returns `ID!` in the server schema.
 *
 * Source:
 *   https://relay.dev/docs/guided-tour/list-data/updating-connections/#deleterecord
 */
import { graphql } from "react-relay";

export const DeleteTodoMutation = graphql`
  mutation DeleteTodoMutation($id: ID!) {
    deleteTodo(id: $id) @deleteRecord
  }
`;
