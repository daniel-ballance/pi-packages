# Separate T3 host-contract repair

Run only for an explicitly requested repair under T3 Code. A release or bridge-hash difference alone is diagnostic, not a failure. Preserve the doctor dump, catalog evidence, failing command, exit code and output. Reproduce the failure with the [live host check](references/verify-host.md).

Use [failure classes](references/failure-classes.md) to find the owning input. Preserve the required behavior; add hermetic tests. **Package:** regenerate, rerun the live host check, `node generator/lint-hosts.mjs`, `npm run check` and `npm test`. **Root:** run `./scripts/check.sh` and the [loader and smoke](references/smoke.md).

On success open a separate host-contract PR with durable evidence and follow [landing](references/land.md). Keep source pins, routes, dependencies and fingerprint refreshes out; no bump note. If verification fails, stop with the evidence. Do not change the installed host.
