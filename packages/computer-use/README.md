# Computer Use for Pi

Two ordinary Pi tools connect to OpenAI's Computer Use Companion on **macOS**:

- `computer_use` executes JavaScript with the initialized `cua` API and returns
  app state, API documentation, and screenshots to Pi.
- `computer_use_reset` discards JavaScript variables and starts a fresh runtime
  on the next call. Native apps and their state remain intact.

No MCP configuration, ChatGPT API key, or other Pi extension is needed. App
consent requests from the bundled runtime are acknowledged automatically for
the current connection, without Pi approval dialogs. No permanent app grants
are written. macOS Screen Recording/Accessibility permissions and the
Companion's app policy still apply.

## Install

Install the collection from Git:

```sh
pi install https://github.com/daniel-ballance/pi-packages
```

Or install this package from a local checkout after installing dependencies:

```sh
npm ci --ignore-scripts
node scripts/patch-pi-host-security.mts
pi install "$PWD/packages/computer-use"
```

Requires **Pi 0.99.2+ and Node.js 22.19.0+**. Install either the collection or
the individual package, then restart Pi or `/reload`.

## Mac setup and detection

Install ChatGPT and its Computer Use plugin through the app's normal setup.
The plugin installs the Companion, currently named `Codex Computer Use.app`.
Grant its required macOS permissions when prompted by macOS. See
[OpenAI's Computer Use setup](https://learn.chatgpt.com/docs/computer-use).

The extension detects:

- `ChatGPT.app` (or the older `Codex.app`) in `/Applications` or
  `~/Applications`, including its bundled signed `cua_node` runtime and Codex CLI.
- The Companion in `${CODEX_HOME:-~/.codex}/computer-use`, `/Applications`,
  or `~/Applications`, under `Codex Computer Use.app` or
  `Computer Use Companion.app`.

For other install locations, set `PI_COMPUTER_USE_CHATGPT_APP` and/or
`PI_COMPUTER_USE_COMPANION_APP` to the absolute `.app` paths before starting Pi.
Explicit overrides are checked and never silently replaced with another app.

On Linux/Windows, or if either app or a required runtime component is missing,
the extension loads quietly, starts no processes, and registers no agent tools.
`/computer-use` explains its availability. After installing/updating the apps,
use `/reload` to register the tools.

The signed launcher is started only on the first tool call. The extension uses
the original bundled `@oai/cua-repl`, NodeREPL, Sky library, and native service;
it does not implement a separate desktop-control backend. Only the computer
surface is enabled. It does not expose the runtime's module-directory mutation
or host cleanup tools to the model.

## Use

Ask Pi to use an app normally, for example: "Use Calculator to compute 2 + 2
and show the result." A first `computer_use` call can contain:

```javascript
var calculator = await cua.getApp("Calculator");
```

The runtime emits the app state and the current API documentation. Follow that
documentation for subsequent actions; the unified `cua` API differs from older
Sky examples. `await cua.getState()` lists available apps. Variables persist
across calls, so reuse them or use `var` when redeclaring a name.

The tool accepts `code`, an optional short `title`, and optional `timeout_ms`
between 1 and 120000 (default JavaScript execution timeout: 30000 ms). Calls are
serialized; a concurrent call returns a busy error. Refresh app state after
actions and use `await cua.rewriteDocumentation()` after context compaction.

The runtime already emits state and screenshots. Use `nodeRepl.write(value)`
or `await nodeRepl.emitImage(image)` only for additional output. Large results
have a bounded preview and a local full-result artifact.

`/computer-use` reports installation/connection status. `/computer-use reset`
also resets the runtime. Reload, session change, branch navigation, cancellation,
transport failure, and shutdown clear connection consent and terminate the
extension's launcher process group. Completed agent runs notify the runtime's
`turn_ended` cleanup hook. A failed or timed-out action is never replayed; inspect
the app state before repeating it.

## Verification and limits

```sh
npm --prefix packages/computer-use run check
npm --prefix packages/computer-use run test
./scripts/check.sh
```

Tests use temporary app bundles and a local MCP fixture: missing installations,
platform gating, automatic consent, persistent calls, screenshot/error mapping,
timeouts, cancellation, reset, and process cleanup. They need no Mac, credentials,
or live app interactions.

This integrates the currently bundled interface, which OpenAI may change in an
app update. The public OpenAI documentation describes use from ChatGPT; it does
not promise compatibility with external Pi clients. Use an awake, unlocked Mac;
unattended/locked operation has not been established for this integration.
