/**
 * @generated SignedSource<<3795e5405f73e6becce8beabafc26170>>
 * @lightSyntaxTransform
 * @nogrep
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

import { ConcreteRequest } from 'relay-runtime';
export type CreateTodoInput = {
  title: string;
};
export type CreateTodoMutation$variables = {
  connections: ReadonlyArray<string>;
  input: CreateTodoInput;
};
export type CreateTodoMutation$data = {
  readonly createTodoEdge: {
    readonly todoEdge: {
      readonly cursor: string;
      readonly node: {
        readonly completed: boolean | null | undefined;
        readonly id: string;
        readonly title: string | null | undefined;
      } | null | undefined;
    } | null | undefined;
  } | null | undefined;
};
export type CreateTodoMutation = {
  response: CreateTodoMutation$data;
  variables: CreateTodoMutation$variables;
};

const node: ConcreteRequest = (function(){
var v0 = {
  "defaultValue": null,
  "kind": "LocalArgument",
  "name": "connections"
},
v1 = {
  "defaultValue": null,
  "kind": "LocalArgument",
  "name": "input"
},
v2 = [
  {
    "kind": "Variable",
    "name": "input",
    "variableName": "input"
  }
],
v3 = {
  "alias": null,
  "args": null,
  "concreteType": "TodoEdge",
  "kind": "LinkedField",
  "name": "todoEdge",
  "plural": false,
  "selections": [
    {
      "alias": null,
      "args": null,
      "kind": "ScalarField",
      "name": "cursor",
      "storageKey": null
    },
    {
      "alias": null,
      "args": null,
      "concreteType": "Todo",
      "kind": "LinkedField",
      "name": "node",
      "plural": false,
      "selections": [
        {
          "alias": null,
          "args": null,
          "kind": "ScalarField",
          "name": "id",
          "storageKey": null
        },
        {
          "alias": null,
          "args": null,
          "kind": "ScalarField",
          "name": "title",
          "storageKey": null
        },
        {
          "alias": null,
          "args": null,
          "kind": "ScalarField",
          "name": "completed",
          "storageKey": null
        }
      ],
      "storageKey": null
    }
  ],
  "storageKey": null
};
return {
  "fragment": {
    "argumentDefinitions": [
      (v0/*: any*/),
      (v1/*: any*/)
    ],
    "kind": "Fragment",
    "metadata": null,
    "name": "CreateTodoMutation",
    "selections": [
      {
        "kind": "ClientExtension",
        "selections": [
          {
            "alias": null,
            "args": (v2/*: any*/),
            "concreteType": "CreateTodoEdgePayload",
            "kind": "LinkedField",
            "name": "createTodoEdge",
            "plural": false,
            "selections": [
              (v3/*: any*/)
            ],
            "storageKey": null
          }
        ]
      }
    ],
    "type": "Mutation",
    "abstractKey": null
  },
  "kind": "Request",
  "operation": {
    "argumentDefinitions": [
      (v1/*: any*/),
      (v0/*: any*/)
    ],
    "kind": "Operation",
    "name": "CreateTodoMutation",
    "selections": [
      {
        "kind": "ClientExtension",
        "selections": [
          {
            "alias": null,
            "args": (v2/*: any*/),
            "concreteType": "CreateTodoEdgePayload",
            "kind": "LinkedField",
            "name": "createTodoEdge",
            "plural": false,
            "selections": [
              (v3/*: any*/),
              {
                "alias": null,
                "args": null,
                "filters": null,
                "handle": "appendEdge",
                "key": "",
                "kind": "LinkedHandle",
                "name": "todoEdge",
                "handleArgs": [
                  {
                    "kind": "Variable",
                    "name": "connections",
                    "variableName": "connections"
                  }
                ]
              }
            ],
            "storageKey": null
          }
        ]
      }
    ]
  },
  "params": {
    "cacheID": "8d0a1fd8aafded9eabcbb23f65cd9c60",
    "id": null,
    "metadata": {},
    "name": "CreateTodoMutation",
    "operationKind": "mutation",
    "text": null
  }
};
})();

(node as any).hash = "8e6cb015b6c53b2cc2ef1ca35e6b80bf";

export default node;
