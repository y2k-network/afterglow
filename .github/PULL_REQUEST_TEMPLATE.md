<!--
Thanks for the PR. A few things that help reviewers move quickly:
- Link the issue this resolves (or describe the user-facing problem if there isn't one yet).
- Keep the diff focused — split unrelated changes into separate PRs when reasonable.
- If this changes the public surface, run `bun run api:update` and commit `etc/afterglow.api.md`.
-->

## What

<!-- One paragraph: what user-facing change does this make? -->

## Why

<!-- The motivation. If this is a bug fix, what was broken and how could it bite someone? -->

## Notes for reviewers

<!-- Anything non-obvious: trade-offs, alternatives considered, follow-ups. -->

## Checklist

- [ ] Tests added or updated (and they fail without the change).
- [ ] `bun run typecheck` passes locally.
- [ ] `bun run lint` passes locally.
- [ ] `bun run ci:inference-guard` passes locally.
- [ ] Changeset added (`bun run changeset`) for any user-visible change.
- [ ] If the public API changed: `etc/afterglow.api.md` is updated.
- [ ] Docs / README updated if the change affects examples or quickstart.
