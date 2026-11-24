# Separate T3 host-contract repair

Run only for an explicitly requested repair under T3 Code. A release or bridge-hash difference alone is diagnostic, not a failure. Preserve the doctor dump, catalog evidence, failing command, exit code and output. Verify the missing or incompatible behavior per the [host map](../poteto-mode/references/host-capabilities.md).

Use [failure classes](references/failure-classes.md) to find the owning input. Preserve the required behavior; add hermetic tests. **Package:** regenerate, run `node generator/check-t3-pin.mjs`, the capability-based doctor check, `node generator/lint-hosts.mjs`, `npm run check` and `npm test`. Verify the repaired behavior live. **Root:** run `./scripts/check.sh` and the [loader and smoke](references/smoke.md).

On success open a separate host-contract PR with durable evidence and follow [landing](references/land.md). Keep source pins, routes, dependencies and fingerprint refreshes out; no bump note. If verification fails, stop with the evidence. Do not change the installed host.
