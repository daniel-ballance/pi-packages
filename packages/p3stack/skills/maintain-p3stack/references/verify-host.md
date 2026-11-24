# Verify the T3 host

1. From `packages/p3stack/`, run `node generator/check-t3-pin.mjs` for the static contract. For installed-state diagnostics, add `--installed` (optionally `--state <file>` or `--bridge <file>`). A different release or bridge hash is not a failure.
2. Launch a fresh T3 Code thread with `PI_CODING_AGENT_DIR` set to a disposable directory outside the checkout and your normal agent directory. Confirm that `$PI_CODING_AGENT_DIR/p3stack/t3-contract.json` is in that directory before running `/p3stack doctor`.
3. From the same package directory, run `node generator/check-t3-pin.mjs --doctor <dump>` on that file. Require no problems, all required tools and their required direct exposures; extra tools and absent optional tools are fine.
4. Doctor checks inventory, not behavior. Compare the live descriptions and observed results for the changed operations with the [T3 host map](../poteto-mode/references/host-t3.md) and the prompt return contract in `rules/t3-pin.json`. Record what you verified and what was unavailable. A missing required capability or incompatible behavior blocks maintenance; keep its repair separate from a source bump.
