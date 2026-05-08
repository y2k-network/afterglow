/**
 * @generated SignedSource<<880ce7eed881d456b990f38fd69bfb70>>
 * @lightSyntaxTransform
 * @nogrep
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

import { ReaderFragment } from 'relay-runtime';
import { FragmentRefs } from "relay-runtime";
export type RefetchableViewer_viewer$data = {
  readonly user: {
    readonly id: string;
  };
  readonly " $fragmentType": "RefetchableViewer_viewer";
};
export type RefetchableViewer_viewer$key = {
  readonly " $data"?: RefetchableViewer_viewer$data;
  readonly " $fragmentSpreads": FragmentRefs<"RefetchableViewer_viewer">;
};

import RefetchableViewerQuery_graphql from './RefetchableViewerQuery.graphql';

const node: ReaderFragment = {
  "argumentDefinitions": [],
  "kind": "Fragment",
  "metadata": {
    "throwOnFieldError": true,
    "refetch": {
      "connection": null,
      "fragmentPathInResult": [
        "viewer"
      ],
      "operation": RefetchableViewerQuery_graphql
    }
  },
  "name": "RefetchableViewer_viewer",
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
  "type": "Viewer",
  "abstractKey": null
};

(node as any).hash = "675add07bce194cd2381a3e7463e3df8";

export default node;
