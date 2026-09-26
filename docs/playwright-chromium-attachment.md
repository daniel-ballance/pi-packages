# Using Chromium with Playwright MCP

Research notes on using the installed Chromium binary and attaching Playwright MCP to the currently-running Chromium instance.

## Executive summary

Playwright does not consult the desktop default-browser association. There are three distinct goals:

1. **Use the installed Chromium executable**: launch a new Playwright-controlled browser process with `--executable-path`.
2. **Attach to a Chromium process exposing CDP**: use `--cdp-endpoint`.
3. **Attach to the user's existing browser profile and tabs**: install the Playwright browser extension and use `--extension`.

The current `mcp-client` implementation already supports all three through generic MCP stdio arguments. No `mcp-client` source change is required for the basic integrations.

## Current system state

The active MCP configuration is:

```text
/home/danballance/.pi/agent/mcp.json
  -> /home/danballance/Work/omarchy-customizations/pi/mcp.json
```

The Playwright server is currently configured with:

```json
{
  "transport": "stdio",
  "command": "npx",
  "args": [
    "-y",
    "@playwright/mcp@latest",
    "--headless",
    "--executable-path",
    "/usr/bin/chromium"
  ]
}
```

Therefore, Playwright MCP is already using the system Chromium executable. It is not using the normal desktop Chromium instance or profile. It launches a separate headless process with a Playwright MCP profile under `~/.cache/ms-playwright-mcp/`.

The currently-running desktop Chromium process was observed without `--remote-debugging-port`, `--remote-debugging-pipe`, or another externally usable CDP endpoint. Local ports 9222–9225 were not listening.

The installed MCP package supports:

- `--executable-path`
- `--cdp-endpoint`
- `--extension`
- `--profile-dir-name`
- `--cdp-header`
- `--cdp-timeout`

## 1. Launching the installed Chromium binary

### Chromium changes

None are required. The binary is already installed at `/usr/bin/chromium`.

### Playwright MCP configuration

`--executable-path` selects the browser executable:

```json
"args": [
  "-y",
  "@playwright/mcp@latest",
  "--executable-path",
  "/usr/bin/chromium"
]
```

The current configuration adds `--headless`, so the browser is not displayed. Removing `--headless` makes it headed, provided the MCP child process can access the graphical session.

Playwright's documented warning is that `executablePath` is supported at the user's risk; Playwright primarily tests its bundled browser builds. A system Chromium update can introduce protocol or behavior differences.

### Profile behavior

A launched Playwright MCP browser normally has its own persistent profile. It should not be pointed at the live desktop profile (`~/.config/chromium`) because:

- Chromium profiles are locked to one browser instance;
- concurrent access can corrupt or interfere with profile state;
- recent Chrome/Chromium security behavior restricts automation of the default profile.

Use a separate `--user-data-dir` if a named automation profile is needed.

### `mcp-client` changes

None. The Pi `mcp-client` extension already:

- accepts arbitrary stdio `args` in `src/config.ts`;
- expands configured environment variables;
- launches the MCP command directly in `src/stdio.ts`;
- connects and registers the server tools in `src/index.ts`.

A configuration reload is needed after changing the MCP server arguments.

## 2. Attaching through Chrome DevTools Protocol

### Chromium changes

Chromium must expose a CDP endpoint, usually by being launched with:

```text
--remote-debugging-port=9222
```

A process that was not launched with an externally reachable CDP endpoint generally cannot be retrofitted with one. In practice, the browser must be restarted with the option, or its built-in remote-debugging approval mechanism must be used if available.

The endpoint should remain loopback-only (`127.0.0.1`). CDP normally provides powerful unauthenticated control over the browser, including access to logged-in pages and cookies.

Recent Chrome security changes are relevant. Chrome documents that, starting with Chrome 136, `--remote-debugging-port` and `--remote-debugging-pipe` are not honored for the default Chrome data directory. A nonstandard `--user-data-dir` is required for that launch mode:

<https://developer.chrome.com/blog/remote-debugging-port>

This may also affect Chromium builds based on the same code. Using a nonstandard profile means the result is no longer the exact everyday profile, so this is not always suitable for the current desktop instance.

`--remote-debugging-pipe` is not a substitute for a TCP endpoint here. A pipe is normally private to the process that launched Chromium and is not a stable endpoint another MCP server can discover.

### Playwright MCP configuration

Point MCP at the CDP endpoint:

```json
"args": [
  "-y",
  "@playwright/mcp@latest",
  "--cdp-endpoint=http://127.0.0.1:9222"
]
```

`--cdp-endpoint` causes Playwright MCP to use Playwright's `chromium.connectOverCDP`. It is a different mode from `--executable-path`; they should not be combined.

The MCP package also supports CDP headers and a CDP connection timeout when those are needed.

### `mcp-client` changes

None. The generic stdio client can launch this configuration unchanged.

The MCP client connects during session startup. If the endpoint is unavailable, the server is marked unavailable; after the endpoint becomes available, `/reload` is needed. The client intentionally does not blindly replay failed or side-effecting operations.

## 3. Attaching to the currently-running browser with the Playwright Extension

This is the mode designed for existing tabs, logged-in sessions, cookies, and installed browser extensions.

### Chromium changes

Install the official Playwright Extension in the desired Chromium profile:

<https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm>

The Playwright extension documentation lists Chrome, Edge, and Chromium as supported browsers:

<https://github.com/microsoft/playwright/blob/main/packages/extension/README.md>

No remote-debugging port or special Chromium startup flag is required. The extension establishes a local relay connection to the Playwright MCP server. The first connection normally requires browser approval and tab selection. A profile-specific extension token can optionally bypass repeated approval dialogs.

If the extension is installed in multiple profiles, use the profile directory name shown by `chrome://version`, commonly `Default` or `Profile 1`.

### Playwright MCP configuration

For this system's unbranded Chromium executable, specify both extension mode and the executable path:

```json
"args": [
  "-y",
  "@playwright/mcp@latest",
  "--extension",
  "--executable-path",
  "/usr/bin/chromium",
  "--profile-dir-name",
  "Default"
]
```

`--profile-dir-name` is optional. Without it, the extension mode uses the last-used profile where the extension is installed.

`--extension` and `--cdp-endpoint` are alternative attachment modes, not settings that should be combined.

### Graphical-session environment

The Pi MCP client intentionally passes only a restricted safe environment to stdio child processes. The default inherited set includes values such as `HOME`, `PATH`, `SHELL`, `TERM`, and `USER`, but not necessarily `DISPLAY`, `WAYLAND_DISPLAY`, or `XDG_RUNTIME_DIR`.

For headed Chromium or the extension helper process, explicit environment forwarding may be needed:

```json
"env": {
  "DISPLAY": "${DISPLAY}",
  "WAYLAND_DISPLAY": "${WAYLAND_DISPLAY}",
  "XDG_RUNTIME_DIR": "${XDG_RUNTIME_DIR}"
}
```

The existing `mcp-client` configuration supports this without a source change. An extension approval prompt can also take longer than the default MCP connection deadline of 60 seconds; the server's `timeout` can be increased if necessary.

### `mcp-client` changes

None for basic support. The browser extension is a separate Playwright/Chromium extension, not the Pi `mcp-client` extension.

A first-class convenience feature could be added to `mcp-client` later, such as a typed browser mode that translates to MCP arguments, but it is not technically necessary. Keeping browser-specific behavior in Playwright MCP and keeping `mcp-client` transport-generic is the current design.

## Comparison

| Goal | Chromium change | Playwright MCP setting | `mcp-client` source change |
| --- | --- | --- | --- |
| Launch installed Chromium | None | `--executable-path /usr/bin/chromium` | None |
| Launch visible Chromium | GUI/session environment may be needed | Remove `--headless` | None; configure `env` if needed |
| Attach over CDP | Launch with CDP or enable browser remote debugging | `--cdp-endpoint=http://127.0.0.1:9222` | None |
| Attach to current tabs/profile | Install Playwright Extension | `--extension`, plus executable/profile options | None |

## Recommended route

For ordinary isolated automation, the existing `--executable-path` configuration is sufficient.

For the exact currently-running desktop Chromium instance, the Playwright Extension route is preferable because it:

- does not require restarting Chromium;
- does not require exposing a CDP TCP port;
- can reuse the existing profile, cookies, sessions, and tabs;
- is explicitly designed for connecting to an existing browser.

## References

- Playwright MCP README and CLI options: <https://github.com/microsoft/playwright-mcp/blob/main/README.md>
- Playwright MCP browser connection documentation: <https://playwright.dev/mcp/configuration/browser-extension>
- Playwright browser extension README: <https://github.com/microsoft/playwright/blob/main/packages/extension/README.md>
- Playwright `connectOverCDP` API: <https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp>
- Chrome remote-debugging security changes: <https://developer.chrome.com/blog/remote-debugging-port>
- Local MCP client configuration: `packages/mcp-client/src/config.ts`
- Local MCP stdio transport: `packages/mcp-client/src/stdio.ts`
- Local MCP extension entry point: `packages/mcp-client/src/index.ts`
