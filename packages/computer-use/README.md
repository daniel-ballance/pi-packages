# Computer Use for Pi

Two ordinary Pi tools connect to OpenAI's Computer Use Companion on **macOS**,
either locally on the Mac or from another machine over SSH:

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

Install the root package from Git:

```sh
pi install git:github.com/daniel-ballance/pi-packages
```

Or install this package from a local checkout after installing dependencies:

```sh
npm ci --ignore-scripts
node scripts/patch-pi-host-security.mts
pi install "$PWD/packages/computer-use"
```

Requires **Pi 1.3.0+ and Node.js 22.19.0+**. Install either the root package or
this package, then restart Pi or `/reload`.

## Local mode: Pi on the Mac

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

Leave `PI_COMPUTER_USE_SSH` unset to use local mode. On Linux/Windows without
SSH configuration, or if either local app or a required runtime component is
missing, the extension loads quietly, starts no processes, and registers no agent tools.
`/computer-use` explains its availability. After installing/updating the apps,
use `/reload` to register the tools.

The signed launcher is started only on the first tool call. The extension uses
the original bundled `@oai/cua-repl`, NodeREPL, Sky library, and native service;
it does not implement a separate desktop-control backend. Only the computer
surface is enabled. It does not expose the runtime's module-directory mutation
or host cleanup tools to the model.

## Remote mode: Pi on Linux, Mac over LAN or Tailscale

Set the destination in **the environment of the process that launches Pi**:

```sh
PI_COMPUTER_USE_SSH=danballance@100.120.109.108 pi
# Or a LAN name/address or an alias from ~/.ssh/config:
PI_COMPUTER_USE_SSH=danballance@dans-mac.local pi
```

For T3, set `PI_COMPUTER_USE_SSH` in its Pi provider's launch environment, then
start a fresh Pi process. A shell export in an already-running Pi tool does not
change Pi's environment. `/reload` alone cannot import a new parent environment.
Unset the variable and restart Pi to return to local mode. An empty or invalid
value disables the tools with a status diagnostic; it never falls back to local.
SSH selection takes precedence even when Pi itself runs on macOS.

Prerequisites:

- `ssh` on the Pi machine, and the same ChatGPT/Companion setup on the remote Mac.
- Key-based authentication usable noninteractively, an already-verified host key
  in known_hosts, and an awake, unlocked Mac. Verify the host key and SSH access
  yourself before starting Pi. The package does not accept new host keys,
  supply passwords, install apps, or change macOS permissions/settings.
- An SSH login shell that accepts POSIX-style quoted commands and keeps stdout
  protocol-only. Put nonstandard ports, IdentityFile, HostName, etc. in
  `~/.ssh/config`; the destination accepts only a host alias or `[user@]hostname`
  / IPv4 address, not flags, URLs, paths, or raw IPv6 literals (use an alias).

The first tool call starts `ssh -T` with BatchMode, strict host-key checking, a
10-second connect timeout and bounded keepalives. Its stdio carries MCP directly
to the Mac's **bundled** launcher: no server, copied runtime, handwritten bridge,
or TCP listener. The existing session, consent, result/image mapping and reset
logic are shared with local mode. No SSH process starts during extension loading.
`/computer-use` reports the destination as configured, not connected, until a
call succeeds. Missing SSH/auth/runtime components produce a tool error with
bounded stderr; failed actions are never automatically retried.

Remote mode defaults to `/Applications/ChatGPT.app`. Set
`PI_COMPUTER_USE_CHATGPT_APP` to an absolute **Mac** app path for older Codex or
nonstandard installs. `PI_COMPUTER_USE_COMPANION_APP`, if set, is also an absolute
Mac path; otherwise the bundled service uses its own Companion discovery.
Remote paths are safely shell-quoted, including spaces and apostrophes. The
Linux machine's `CODEX_HOME` is not forwarded; the remote login environment and
runtime defaults apply. Remote app paths are checked by the runtime on first
use, not by local filesystem detection.

### Migrating from the optional MCP entry

The `mac-computer-use` server in `~/.pi/agent/mcp.json` is **not required** for
this package. Remove or disable that entry when adopting this path, then restart
Pi; use `computer_use` / `computer_use_reset`, not `mcp__mac_computer_use` tools.
Do not interrupt a server another running session is using. This change does
not edit your MCP configuration automatically. Pi's native MCP client currently
cannot answer this runtime's form elicitations, so keeping that entry does not
provide a working alternative for app actions. The optional `mcp-client` package
is not needed and has separate approval/configuration semantics.

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
extension's local launcher process group (the SSH client in remote mode).
Normal SSH disconnect closes remote stdio; the bundled runtime owns its remote
children. Network partitions or a forcibly killed client cannot guarantee prompt
remote process cleanup, and do not undo app actions. Completed agent runs notify the runtime's
`turn_ended` cleanup hook. A failed or timed-out action is never replayed; inspect
the app state before repeating it.

## Verification and limits

```sh
npm --prefix packages/computer-use run check
npm --prefix packages/computer-use run test
./scripts/check.sh
```

Tests use temporary app bundles, a local MCP fixture and a fake SSH boundary:
missing installations, local/remote selection, invalid configuration, remote shell
quoting, all supported consent operations, fail-closed unknown requests, persistent
calls, screenshot/error mapping, SSH stderr/failure without retries, timeouts,
cancellation, reset, process cleanup, and status with/without UI. They need no Mac,
credentials, or live app interactions.

Remote acceptance was also exercised from Linux using Pi's extension loader and
the registered tools: Calculator state read, one `Escape` key press, then a fresh
full state and JPEG screenshot, followed by reset. No Safari, Messages, Mail,
permissions or app settings were touched. Local-on-Mac execution was not exercised
from Linux; its detection/launch path is covered by fixtures.

Consent remains session-only, in memory, scoped to exact app bundle IDs on the
active connection. As before, recognized native app consent is automatic for
`get_app_state`, `click`, `drag`, `paste`, `perform_secondary_action`, `press_key`,
`scroll`, `select_text`, `set_value`, and `type_text`; this is not a Calculator-only
allowlist or a per-action human approval gate. Other operations, generic forms,
URL elicitations, and permanent-only requests are declined, even for a previously
granted app. The native service's app restrictions still apply. This JavaScript
tool is not a sandbox or permission to perform sensitive external actions; follow
the user's intent and confirmation requirements. Separate Pi sessions do not
coordinate access to the same Mac: keep desktop actions serialized with other users.

This integrates the currently bundled interface, which OpenAI may change in an
app update. The public OpenAI documentation describes use from ChatGPT; it does
not promise compatibility with external Pi clients. Use an awake, unlocked Mac;
unattended/locked operation has not been established for this integration.
