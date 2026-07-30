/**
 * @generated SignedSource<<8a02e7226b72799c85f630cda50a18d8>>
 * @lightSyntaxTransform
 * @nogrep
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

import { ReaderFragment } from 'relay-runtime';
import { FragmentRefs } from "relay-runtime";
export type TodoItem_todo$data = {
  readonly completed: boolean;
  readonly createdAt: string | null | undefined;
  readonly id: string;
  readonly title: string;
  readonly " $fragmentType": "TodoItem_todo";
};
export type TodoItem_todo$key = {
  readonly " $data"?: TodoItem_todo$data;
  readonly " $fragmentSpreads": FragmentRefs<"TodoItem_todo">;
};

const node: ReaderFragment = {
  "argumentDefinitions": [],
  "kind": "Fragment",
  "metadata": {
    "throwOnFieldError": true
  },
  "name": "TodoItem_todo",
  "selections": [
    {
      "alias": null,
      "args": null,
      "kind": "ScalarField",
      "name": "id",
      "storageKey": null
    },
    {
      "kind": "RequiredField",
      "field": {
        "alias": null,
        "args": null,
        "kind": "ScalarField",
        "name": "title",
        "storageKey": null
      },
      "action": "THROW"
    },
    {
      "alias": null,
      "args": null,
      "kind": "ScalarField",
      "name": "completed",
      "storageKey": null
    },
    {
      "kind": "CatchField",
      "field": {
        "alias": null,
        "args": null,
        "kind": "ScalarField",
        "name": "createdAt",
        "storageKey": null
      },
      "to": "NULL"
    }
  ],
  "type": "Todo",
  "abstractKey": null
};

(node as any).hash = "a54bcd129fc1c12570a549911f75abe5";

export default node;
