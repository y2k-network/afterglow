/**
 * @generated SignedSource<<07f664f1edb392342157b9248f6857ba>>
 * @lightSyntaxTransform
 * @nogrep
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

import { ConcreteRequest } from 'relay-runtime';
import { FragmentRefs } from "relay-runtime";
export type RefetchableViewerQuery$variables = Record<PropertyKey, never>;
export type RefetchableViewerQuery$data = {
  readonly viewer: {
    readonly " $fragmentSpreads": FragmentRefs<"RefetchableViewer_viewer">;
  } | null | undefined;
};
export type RefetchableViewerQuery = {
  response: RefetchableViewerQuery$data;
  variables: RefetchableViewerQuery$variables;
};

const node: ConcreteRequest = {
  "fragment": {
    "argumentDefinitions": [],
    "kind": "Fragment",
    "metadata": null,
    "name": "RefetchableViewerQuery",
    "selections": [
      {
        "alias": null,
        "args": null,
        "concreteType": "Viewer",
        "kind": "LinkedField",
        "name": "viewer",
        "plural": false,
        "selections": [
          {
            "args": null,
            "kind": "FragmentSpread",
            "name": "RefetchableViewer_viewer"
          }
        ],
        "storageKey": null
      }
    ],
    "type": "Query",
    "abstractKey": null
  },
  "kind": "Request",
  "operation": {
    "argumentDefinitions": [],
    "kind": "Operation",
    "name": "RefetchableViewerQuery",
    "selections": [
      {
        "alias": null,
        "args": null,
        "concreteType": "Viewer",
        "kind": "LinkedField",
        "name": "viewer",
        "plural": false,
        "selections": [
          {
            "alias": null,
            "args": null,
            "concreteType": "User",
            "kind": "LinkedField",
            "name": "user",
            "plural": false,
            "selections": [
              {
                "alias": null,
                "args": null,
                "kind": "ScalarField",
                "name": "id",
                "storageKey": null
              }
            ],
            "storageKey": null
          }
        ],
        "storageKey": null
      }
    ]
  },
  "params": {
    "cacheID": "9099972a21cfeb5b7b36126ee6350bc3",
    "id": null,
    "metadata": {},
    "name": "RefetchableViewerQuery",
    "operationKind": "query",
    "text": "query RefetchableViewerQuery {\n  viewer {\n    ...RefetchableViewer_viewer\n  }\n}\n\nfragment RefetchableViewer_viewer on Viewer {\n  user {\n    id\n  }\n}\n"
  }
};

(node as any).hash = "675add07bce194cd2381a3e7463e3df8";

export default node;
