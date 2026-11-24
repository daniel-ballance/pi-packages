# Verify the T3 host

1. Under T3 Code, start a fresh thread loading the checkout under test. Set `PI_CODING_AGENT_DIR` to a disposable directory outside the checkout and your normal agent directory. Run `/p3stack doctor` and use the new `$PI_CODING_AGENT_DIR/p3stack/t3-contract.json` as the dump.
2. **Inventory.** From `packages/p3stack/`, run `node generator/check-t3-contract.mjs --doctor <dump>`. Require exit 0: all required operations are present with the required exposures, and the doctor reports no problems. A missing dump leaves inventory unverified. The root receipt covers the static host map check, not this thread.
3. **Behavior.** Request `p3stack_roles` in the thread and confirm it resolves roles against the live catalog. For each changed host operation, check the live arguments and observe the result against the [T3 host map](../poteto-mode/references/host-t3.md). Stay within the caller’s grant. Record what ran, the nonsecret result, and any behavior you could not exercise. Missing or unverified required behavior blocks maintenance; its repair belongs outside a source bump.

For a support fingerprint only, run `node generator/check-t3-contract.mjs --installed` from the package. Supply `--state <file>` or `--bridge <file>` to identify a different installation. A version or hash is not a capability receipt.
