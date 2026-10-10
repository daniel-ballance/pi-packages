# MCP additions

An opt-in, shrinking compatibility layer for Pi's **native** MCP client—not a replacement connection manager or Computer Use server.

## Parked — replacement-client direction selected

The user chose to evolve the existing `mcp-client` replacement rather than wait
for new upstream hooks. See [current implementation work](../mcp-client-alignment/README.md).
The documents below are retained as research/proposals, not an active delivery plan.

## Historical design milestone

Design and compatibility investigation only. **There is no installable `mcp-additions` package yet.** Pi 1.1.0 lacks the public client-feature hooks needed to implement this design safely. No global settings, native MCP connections, or Mac permissions have been changed.

- [Compatibility matrix](COMPATIBILITY.md): official version policy and native Pi feature coverage, with primary sources.
- [Design and upstream hook proposal](DESIGN.md): ownership, lifecycle, approvals, configuration boundaries, and retirement rules.
- [Acceptance plan](ACCEPTANCE.md): required deterministic, RPC/T3, live Calculator, and native-retirement tests. These are planned tests, not passing results.

## First implementation slice

Form elicitation, explicitly enabled per server, using native Pi connections and normal human approval dialogs. Native transport, OAuth, tools/resources, and image delivery remain Pi's responsibility.

The existing `packages/mcp-client` has UI/validation code worth reviewing for reuse, but loading its extension would replace native MCP. That is not the chosen architecture.

## Next gate

Implement and validate the upstream hook in a development Pi checkout before building `packages/mcp-additions` against it. Do not create a package that guesses private internals or claims a proposed API is available. Opening an upstream issue/PR is a separate publication step; none has been opened by this milestone.

Each feature must stop activating when Pi explicitly owns equivalent native support. A native feature disabled by the user must stay disabled, not be silently re-enabled by the package.
