# MCP status design

The MCP client uses Pi's native extension status slot rather than replacing the footer.

- Healthy, disabled, unconfigured, or normally connecting: no indicator.
- Partial failures: one compact warning in the theme's warning colour.
- Total failure or invalid configuration: one compact error.
- Recovery: clear silently. No counters when healthy, animations, or recovery toasts.
- Details remain in `/mcp status`; ordinary tool-operation errors do not imply a broken connection.

The native slot sits below the usage/model line. It adds no row when all extension statuses are absent.

## Visual references

- [Design mockup](mcp-status-mockup.png): illustrative HTML rendering, **not a screenshot of the implemented Pi extension**. Session values and colours are illustrative.
- [Minimal-footer reference](pi-minimal-footer-reference.png): browser screenshot of the [pi-minimal-footer README](https://github.com/ogulcancelik/pi-extensions/tree/main/packages/pi-minimal-footer), including its published terminal screenshots. Third-party reference by ogulcancelik, retained for design context, not our implementation.

Also reviewed [pi-compact-tui](https://pi.dev/packages/pi-compact-tui), whose configurable footer can place extension statuses independently. The useful ideas were restrained typography and colour, not adopting a replacement footer or additional dependencies.
