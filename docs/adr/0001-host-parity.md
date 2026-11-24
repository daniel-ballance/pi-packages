# Host parity: one contract per capability, a native backend per host

Pi runs in a terminal and under T3 Code. Skills ask for a capability, such as delegation or scheduling. The [host map](../../packages/p3stack/extra/skills/poteto-mode/references/host-capabilities.md) names the operation on each host and any gaps. Extensions use [the shared helper](../../shared/host.ts) to detect the host.

## Considered options

- **One delegation system everywhere**: rejected. A second Manager under T3 would create children outside T3's task tree, cancellation, and UI. The subagents component registers no tools there.
- **Hide every duplicate tool under T3**: rejected. A deferred tool stays available to tool search and codemode without taking space in the prompt. For example, todo uses deferred exposure if T3 supplies a counterpart.
- **Detect the host in each extension**: rejected. Standalone installs need the same detection rule as the root package. A generated copy avoids a separate runtime dependency. The root check catches stale copies.

## Consequences

- Keep tool results useful as plain text. Check `hasUI` before calling the UI. If an unattended question needs a default, tell the caller which default to apply. A display-only command can do nothing without a UI.
- In p3stack, `npm test` runs `test/extension.test.ts` first with `T3_MCP_URL` unset and again with a fake URL. This suite exercises host-dependent setup, roles, delegation briefs, and mode display at the extension boundary. Add any new host-sensitive suite to the second pass. The compiler corpus, generator, static checks, and playbook helpers do not select a host and run once. The root gate runs the nested components' own suites separately.
- A fake URL exercises a code path, not the T3 bridge. Check live behavior under T3 before claiming that a capability works there.
