/**
 * Mutation exercising `@appendEdge` (declarative-connection mutation directive
 * — requires a field returning the Edge type, with `connections: [ID!]!`).
 *
 * Note: our example schema does NOT yet ship a `createTodoEdge` field that
 * returns `TodoEdge`. To keep this test honest *and* exercise @appendEdge,
 * we provide a `relay-extensions.graphql` schema extension that adds a
 * mutation field returning `TodoEdge`. relay-compiler merges it with the
 * server SDL just like a real client would do for client-only schema deltas.
 *
 * Source:
 *   https://relay.dev/docs/guided-tour/list-data/updating-connections/
 */
import { graphql } from "react-relay";

export const CreateTodoMutation = graphql`
  mutation CreateTodoMutation(
    $input: CreateTodoInput!
    $connections: [ID!]!
  ) {
    createTodoEdge(input: $input) {
      todoEdge @appendEdge(connections: $connections) {
        cursor
        node {
          id
          title
          completed
        }
      }
    }
  }
`;
