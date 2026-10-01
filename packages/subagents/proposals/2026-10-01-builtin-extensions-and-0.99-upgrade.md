# Pi 0.99.2: managed built-ins (design before implementation)

## Scope

Use Pi's built-in codemode, tool-search and MCP implementations. Do not extend or remove `packages/mcp-client` in this change. No personal policy edits, paid providers or real credentials. Initially pushes were excluded; the user subsequently authorized completion, verification, push, merge to main and local cleanup. Child policies are capability controls inside cooperative Pi processes, **not a sandbox**.

## Phase 0 evidence

Inspected the installed 0.99.2 documentation and npm-distributed implementation. Local, offline RPC probes used a deterministic chat provider, a classifier reporting synthetic $0.25 usage, a nested tool reporting synthetic $0.50 usage, and a tiny stdio MCP fixture. Original probe artifacts are private worktree files in `.pi/probes/`. The core experiments are now reproducible in `test/builtins-probe-rpc.test.ts` with `test/fixtures/builtin-probe-{provider,mcp}.mjs`; run with `PEER_TEST_EXECUTABLE="$(command -v pi)"`. The characterization tests now run against the pinned 0.99.2 Node CLI by default and support the installed executable override.

1. **Explicit built-ins alongside `--no-extensions`: confirmed.** `getAllTools()` reports `builtin:codemode` and `builtin:tool-search` sources. Ambient extensions remain disabled. A mandatory separately loaded guard runs.
2. **Nested guard interception: confirmed.** Even registered deferred tools omitted from active declarations reach `tool_call` through codemode, with `parentToolCallId`. The guard blocks both unselected `forbidden` and `subagent_forbidden`; exceptions reach the script.
3. **Search is discovery, not permission: confirmed.** With broad CLI visibility, `tool_search` says it loaded `forbidden`; the existing guard removes it again. Prefer a filtered registry view plus call-time enforcement, not an activation feedback loop.
4. **Classifier calls bypass tool hooks: confirmed.** Stock codemode calls the deterministic classifier without another `tool_call`. `createCodemodeExtension({models:false})` removes the namespace; cumulative RPC stats distinguish $0.75 stock from $0.50 with models disabled. Reject classifier grants rather than promise model-level interception.
5. **MCP connects before tool use: confirmed.** Both global and trusted project fixture processes start under stock MCP. `createMcpExtension({loadConfig:()=>({servers:[],errors:[]})})` starts neither. Source inspection additionally shows extension-registered servers are merged separately; filtering only `loadConfig` is insufficient. Server and credential filtering must precede the built-in client's connection setup. Filter extension registrations too.
6. **Virtual models: metadata confirmed.** The fixture virtual model has `api: "pi-virtual"`; exact provider/model selection alone cannot fence its routing. Reject virtual selections for now. Provider-extension linkage and missing-extension refusal need dedicated regression tests.
7. **Settings: project override is insufficient.** The RPC probe reports effective project `cacheWarming: "off"` while source `SettingsManager.getCacheWarmingMode()` reads global settings. Codemode factory options override ambient mode/budget without writes. The public `cache_warming_decision` hook can return `{action:"stop"}`; a timed no-network warming regression remains needed. There is no documented general-purpose CLI per-process settings override. `autoEnableCodemode` belongs to `mcp.json`, not settings.
8. **Usage: cumulative stats confirmed for classifier and nested tools.** $0.75 and $0.50 respectively, counted once. Cache warming persists a session `usage` entry (source evidence); refresh on entry events as well as messages and turns. Do not reconstruct cumulative costs by summing nested events.
9. **RPC dispositions: confirmed.** The probe returns `{disposition:"started"}` for ordinary prompt, `{disposition:"handled"}` for input consumed by an extension (prompt, steer, follow_up), and `{disposition:"queued"}` for steer/follow_up. Acknowledgement is not task completion; handled input must not leave a phantom running assignment or successful workflow artifact.

Baseline against installed executable: package tests 213 passed, 1 skipped, 0 failed. This is compatibility evidence for existing behavior, not proof of the new policy design.

## Proposed smallest contract

Keep version 1, whole-file replacement and all old defaults/grants. Add optional fields only; validate their complete shape and reject unknown keys.

- Allow exact `builtin:codemode`, `builtin:tool-search`, `builtin:mcp` identifiers in `extensions`. Reject every other `builtin:*`, especially `builtin:llama.cpp`. Canonical file rules remain unchanged.
- Built-in selection and tool permission are separate: codemode/tool_search require both. Loading a built-in must not grant extra tools.
- `providerExtensions`: provider ID to exact allowlisted extension file. Selection must explicitly include that extension. Virtual models remain unavailable.
- `childSettings`: optional codemode `{mode:"on"|"only", inlineBudget:nonnegative integer}` and `cacheWarming:"off"`. No arbitrary settings passthrough or disk writes. Absent fields preserve inheritance; diagnostics explain inherited warming and codemode behavior.
- `mcp`: `{servers:[{name,tools:[exact raw names or trailing-* prefixes],project:boolean}],inheritCredentials:boolean}`. Defaults are no servers, no project config and no credential consent. Composition selects server names separately; its grant is bounded by the policy entry. Native MCP configuration supplies endpoints, not policy JSON. Never infer permission from a normalized `mcp__` prefix alone.
- If Pi's public API cannot support credential-free native loading without recreating credential management, refuse MCP launch without explicit `inheritCredentials:true` rather than silently access ambient stores. This consent includes configured headers/env/provider/OAuth credentials; it does not isolate an executable server from the host. Project provider-token auth remains prohibited.

## Enforcement design

Use public built-in factories from the always-loaded guard. Implementation refinement: tool-search also uses its exported factory so its registry view can be filtered, avoiding misleading forbidden-tool activation. This deliberately avoids importing unsupported `dist/` modules. File extensions remain trusted executable code.

For codemode, disable `models`, filter the API's tool inventory to the selected grant, and preserve Pi's native nested execution path. For MCP, read only explicitly eligible existing configuration entries and have Pi validate registrations. The native factory gets no ambient config and sees only the approved registered servers. Do not implement transports, OAuth, a second tool executor or a second client. Suppress the native configuration-mutating command in managed children.

Record source/exposure metadata from child `getAllTools()`, not only active declarations. Check selected extension provenance at handshake and again at execution; deferred/codemode-only tools need not be active to be callable. MCP tool names can collide after normalization, so authorize original server/tool identities carried by native registration rather than stripping prefixes. Deny resources until separately designed.

Manager receives a secret-free compiled child policy, revalidated on resume. It refreshes authoritative RPC statistics on usage entries. Send results carry the observed disposition; workflows reject consumed task inputs rather than fabricate successful work. Peer delivery retains consumed/queued distinctions and does not refund unknown acceptance.

## Rejected alternatives

- Ambient `-e builtin:mcp` plus call-time tool filtering: ungranted servers already connect and credentials may already be sent.
- Regex scanning JavaScript for classifier or recursive calls: bypassable and unnecessary with supported namespace disabling and nested hooks.
- Copying OAuth tokens into child homes or forking Pi's MCP client: duplicates maintenance and creates token-rotation hazards.
- Treating active tools as all reachable tools: false for codemode and deferred exposure.
- Broad generic settings/environment overrides: adds an escape hatch with unclear persistence.
- Supporting virtual routing or classifier allowlists speculatively: no verified public interception contract.

## Initial implementation checkpoint (superseded below)

Committed separately after this design: reproducible built-in characterization tests; handled/queued/started/unknown submission reporting; consumed-input rollback without phantom assignments; peer disposition retention without refunds; workflow rejection and attempt recording for consumed inputs; authoritative cost refresh for standalone usage/summary entries.

Checks at this checkpoint: package `npm run check` passed; package tests against the installed Pi executable passed (219 passed, 1 skipped); canonical root `./scripts/check.sh` passed. No dependency/version bump or production built-in grants have been implemented yet. The schema above remains a proposal and must **not** be copied into a live policy.

## Implemented contract and verification

Version 0.3.0 pins Pi 0.99.2 development dependencies. The schema above is implemented; the current [built-in reference](../skills/subagents/reference/builtins.md) is the operational contract. Existing policies gain no implicit tools, MCP servers or credential consent. Unsupported classifier and virtual-model grants remain denied.

`child-policy.test.ts` covers strict optional fields, forbidden built-ins, raw-name patterns, namespace collisions, provider/tool resource linkage and virtual-model omission. `guard.test.ts` covers runtime provenance replacement and model mismatch. `managed-builtins-rpc.test.ts` exercises both runtimes with real native factories: filtered tool-search, classifier namespace removal, nested metered usage, direct-call denial, raw MCP tool-name collisions, direct/deferred exposure, global/project trust and consent, startup/later registered-server suppression, missing consent, forbidden project provider auth, file immutability and close/resume. Native timed warming fixtures confirm global-only inheritance, per-child suppression and idle cumulative-cost updates without a paid request. Earlier disposition regressions cover consumed child/peer/workflow submissions.

The wrapper must retain Pi's non-enumerable tool-context capabilities: copying context with object spread dropped `executeTool`. A proxy preserves the actual context and only filters `tools`. MCP names are authorized from the native adapter's original `server/tool` label, never reconstructed from sanitized names; this is a pinned-runtime compatibility assumption. Factories are the only executors/clients; no transport or OAuth implementation was added.

Local npm checks passed for both locked dependencies and an all-packages Pi 0.99.2 override. The latter required a test-only self-reload context typing update for Pi's richer tool context. The legacy MCP package remains unchanged. Separate pnpm/final installed-executable verification is recorded in the final evidence section after running it.

Residual limits: trusted code can invoke providers, change models or perform side effects outside tool hooks; startup identity checks are not a general model-call firewall. No OS isolation or exact billing guarantees. MCP requires explicit ambient credential inheritance consent; credential-free store isolation, extension-registered server grants and resources/prompts remain unsupported. Only selected config entries are loaded; network availability still belongs to Pi's client and is not guaranteed by a grant.
