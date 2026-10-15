# Host parity: one contract per capability, a native backend per host

Pi runs in a terminal and under T3 Code, which injects its own delegation, scheduling, worktree and pull-request tools. We write every skill against a host-neutral contract (delegate, wait, cancel, worktree, wake, ask, todo) and satisfy it with a native backend on each host, chosen by one shared helper (`shared/host.ts`, `T3_MCP_URL` set means T3). Under T3, a package tool that duplicates a T3 primitive is registered with `deferred` exposure; under the terminal nothing a skill relies on is missing. Results are complete as plain text, and every `ctx.ui` call checks `hasUI` and states the default it applied.

## Considered Options

- **One backend everywhere** (run this repository's tools under T3 too): two delegation systems would compete in one prompt, and T3's UI, cancellation and PR tracking would not see the work. Rejected.
- **Omit or deactivate duplicated tools under T3** (`defaultActive: false`): an inactive `direct` tool is unreachable from both tool search and codemode, so a program written against it breaks. `deferred` keeps it reachable without prompt cost; T3's own Pi bridge registers its optional tools the same way.
- **Per-package environment checks**: each extension re-reading `T3_MCP_URL` drifts. The helper is copied into each package (packages ship standalone) and the root check fails on a stale copy.

## Consequences

- Packages that use the helper run their tests twice, with and without a fake `T3_MCP_URL`; tests of host-specific behaviour pin their host.
- Some rows cannot be identical on both hosts. pistack's `host-capabilities` reference states each gap (for example, only the root T3 thread can watch a pull request) instead of hiding it.
