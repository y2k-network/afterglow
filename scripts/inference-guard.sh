#!/usr/bin/env bash
#
# CI inference guard — locks the parent-typing inference contract.
#
# What this protects (per taste's spec, T40):
#   1. `args.first` on plain-T queryField  → `{}` vs `Record<string, never>`
#      overload contract (Connection footgun elimination).
#   2. `u.NAME_TYPO` in the typoGuard      → `f(Schema.String, { resolve })`
#      callback-with-typed-helper parent inference.
#   3. `u.EMAIL_TYPO` in the pipeGuard     → `Schema.String.pipe(resolve(...))`
#      indexed-signature `NodeFields<T>` regression target. THIS IS THE BIG ONE.
#
# How it works:
#   - Read `src/builder.test.ts` (the canonical smoke test).
#   - Strip every `// @ts-expect-error` line into a temp copy at the same path
#     (so `tsconfig.json` includes it the way the project normally does).
#   - Run `bunx tsc --noEmit` against the project.
#   - For each expected error, grep stderr — fail if any one is missing.
#   - Restore the original file in EVERY exit path (success, failure, ^C, kill).
#
# Special case: if the pipe-form error (#3) goes silent, the failure message
# names the indexed-signature invariant explicitly. That's the regression that
# would NOT be caught by removing `@ts-expect-error` alone — TS would flip the
# directive to TS2578 "Unused" instead of failing the build, which is exactly
# what we're trying to detect.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEST_FILE="${REPO_ROOT}/src/builder.test.ts"
BACKUP="$(mktemp -t builder.test.ts.bak.XXXXXX)"

# Each entry: a substring of the expected `tsc --noEmit` stderr line. We grep
# rather than match exact column numbers, since refactors of the test file
# shift line/column. The test names + property names are stable.
EXPECTED=(
  "Property 'first' does not exist on type '{}'"
  "Property 'NAME_TYPO_SHOULD_ERROR' does not exist on type 'HarnessUser'"
  "Property 'EMAIL_TYPO' does not exist on type 'HarnessUser'"
  "Type 'TodoT | null' is not assignable to type 'TodoT'"
)
LABELS=(
  "footgun guard (#1: queryField args: {} on plain-T)"
  "typo guard (#2: f(...) callback parent inference)"
  "pipe guard (#3: Schema.String.pipe(resolve(...)) — indexed-signature NodeFields<T> regression target)"
  "nullability guard (#4: nonNull: true rejects null-returning resolvers — WireResult<T, NN>)"
)

cleanup() {
  if [[ -f "${BACKUP}" ]]; then
    cp "${BACKUP}" "${TEST_FILE}"
    rm -f "${BACKUP}"
  fi
}
trap cleanup EXIT INT TERM

if [[ ! -f "${TEST_FILE}" ]]; then
  echo "inference-guard: ${TEST_FILE} not found — has the smoke test moved? Update scripts/inference-guard.sh." >&2
  exit 2
fi

cp "${TEST_FILE}" "${BACKUP}"

# Strip every `// @ts-expect-error` line. Use perl for portable in-place edit.
perl -i -ne 'print unless m{//\s*\@ts-expect-error}' "${TEST_FILE}"

# Run tsc, capture stderr+stdout. We don't care about the exit code — it
# WILL be non-zero (we just stripped the suppressors). We care about whether
# the expected diagnostics appear.
TSC_OUT="$(bunx tsc --noEmit 2>&1 || true)"

MISSING=()
for i in "${!EXPECTED[@]}"; do
  if ! printf '%s\n' "${TSC_OUT}" | grep -qF -- "${EXPECTED[$i]}"; then
    MISSING+=("${LABELS[$i]}")
  fi
done

if [[ ${#MISSING[@]} -gt 0 ]]; then
  echo "==================================================================="
  echo "  inference-guard: REGRESSION DETECTED"
  echo "==================================================================="
  echo
  echo "Stripped \`@ts-expect-error\` directives from ${TEST_FILE} but tsc"
  echo "did not produce the expected TS2339 errors. The parent-typing"
  echo "inference contract has silently broken."
  echo
  echo "Missing diagnostics:"
  for m in "${MISSING[@]}"; do
    echo "  - ${m}"
  done
  echo
  if printf '%s\n' "${MISSING[@]}" | grep -q "pipe guard"; then
    echo "The pipe guard is the canary for \`Schema.X.pipe(GraphQL.resolve(fn))\`"
    echo "parent-inference regressions. Likely cause: \`NodeFieldOutput<T>\` in"
    echo "\`src/builder.ts\` no longer contains \`WithResolver<T, Schema.Top>\`,"
    echo "which is the union member that contextually-types \`fn\`'s parent param"
    echo "to T at the assignment site. Restore the union to:"
    echo
    echo "    type NodeFieldOutput<T> ="
    echo "      | FieldDef<T, any>"
    echo "      | WithResolver<T, Schema.Top>     // <-- pipe form depends on this"
    echo "      | Schema.Top"
    echo "      | ScalarType<any>"
    echo "      | SchemaClass<any>"
    echo "      | IDMarker"
    echo
    echo "Without WithResolver in the union, TS sees pipe results as bare"
    echo "Schema.Top and \`u\` collapses to \`unknown\` — typos pass silently."
    echo
  fi
  echo "Full tsc output for the stripped file:"
  echo "-------------------------------------------------------------------"
  printf '%s\n' "${TSC_OUT}"
  echo "==================================================================="
  exit 1
fi

echo "inference-guard: ok — all ${#EXPECTED[@]} TS2339 contracts hold."
