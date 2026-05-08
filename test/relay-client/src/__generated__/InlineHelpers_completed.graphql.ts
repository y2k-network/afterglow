/**
 * @generated SignedSource<<acae74219e40aecdf5c1daa9df16955b>>
 * @lightSyntaxTransform
 * @nogrep
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

import { ReaderFragment } from 'relay-runtime';
import { FragmentRefs } from "relay-runtime";
export type InlineHelpers_completed$data = {
  readonly completed: boolean | null | undefined;
  readonly " $fragmentType": "InlineHelpers_completed";
};
export type InlineHelpers_completed$key = {
  readonly " $data"?: InlineHelpers_completed$data;
  readonly " $fragmentSpreads": FragmentRefs<"InlineHelpers_completed">;
};

const node: ReaderFragment = {
  "argumentDefinitions": [],
  "kind": "Fragment",
  "metadata": null,
  "name": "InlineHelpers_completed",
  "selections": [
    {
      "alias": null,
      "args": null,
      "kind": "ScalarField",
      "name": "completed",
      "storageKey": null
    }
  ],
  "type": "Todo",
  "abstractKey": null
};

(node as any).hash = "d18450da4193d86b5cec47bc4791193c";

export default node;
