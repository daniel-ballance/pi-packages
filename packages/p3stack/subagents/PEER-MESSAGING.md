# Peer messaging: design and verification

## Scope

Parent-authorized, bidirectional, non-transitive links between children tracked by one manager. A ↔ B and B ↔ C do not authorize A ↔ C. No broadcast, channel, polling inbox, supervisor, recursive management or approval delegation.

## API and policy

- `peerMessageLimit`: policy ceiling (integer 0–1000, omitted/default 0 disables). `peer_send` must also be allowlisted and explicitly selected by both children.
- Parent `subagent_connect({a,b,limit})`: create a link with independent allowances in both directions. Reconnecting retains counters and limits; omit limit for reconnect. Repeating a connection never renews it.
- Parent `subagent_disconnect({a,b})`: reject subsequent sends. Already submitted messages cannot be retracted.
- Parent `subagent_renew({sender,recipient,limit})`: replace that direction's allowance with a new generation, explicitly resetting its used count; lifetime total retained. No renewal while that direction has a submission in flight.
- Parent `subagent_peers({id?,since?})`: inspect links and paginated bounded message history without acknowledging ordinary reports.
- Child `peer_send({recipient,message})`: point-to-point text, max 4000 characters; returns message ID, delivery status and remaining allowance. No model-supplied sender identity or management operations.

Existing policies do not gain communication permissions. Removing the capability prevents new sends/connections/renewals after reload, while disconnect/history stay usable.

## Transport and delivery

An extra inherited duplex pipe connects each opted-in child to its manager. The manager binds identity to the child process, not request text. No listening port, shared secret or discovery file. This is not an OS sandbox: unrestricted bash/trusted extensions retain host privileges.

Use RPC `prompt` with `streamingBehavior: steer` for every peer delivery: Pi queues it at the next tool boundary when working and starts a turn when idle, resolving the working→idle race inside Pi. Wrap the body in a manager-generated attributed envelope, explicitly identifying it as untrusted peer work output, not user instructions/permissions; a leading slash in the body cannot invoke a command.

Reject self/unlinked/unknown recipients, starting/stopping/stopped/failed/waiting-for-input children, abort-in-progress and unavailable capability. Never restart a process or answer human dialogs. Replying requires an explicit `peer_send`; ordinary assistant output remains parent-visible.

## Accounting and recovery

Reserve and persist a directional slot before any asynchronous delivery. Concurrent sends cannot overspend. Definitive RPC rejection refunds the slot; unknown acceptance (timeout/exit) retains it. No automatic retries/replay. Accepted means RPC accepted/queued, not model success. On Pi runtimes that report input disposition, the peer history retains it. `handled` means an extension consumed the envelope without an observed receipt; it retains its allowance (the extension may have side effects), survives recovery, and is not automatically retried. A matching user-message event marks `received` (entered conversation, not proof of model reading/answering). Aborting/closing/reload can discard queued messages; retained counts do not reset. Unconfirmed deliveries become `interrupted` across recovery, never implicitly redelivered.

Links and allowance generations persist with the manager registry. Message bodies/history are bounded to 200 entries (pagination and gap indication); counters/lifetime totals persist beyond history eviction. Pending submissions are not evicted. Stable message IDs identify records. Rejected preflight attempts are tool errors, not durable messages. Ordinary peer traffic does not itself create parent notifications; child completion/error/input reporting keeps its existing semantics.

## Acceptance tests / implementation sequence

1. Policy opt-in and selected-tool guard, process-bound transport and bounded framing.
2. Manager graph, reservation/refund/unknown handling, lifecycle and durable audit state.
3. Parent tools, child tool and documentation.
4. Unit tests for unauthorized pairs, no transitivity, spoofed sender fields, directional concurrent limits, reconnect/renew, policy downgrade, failures and recovery.
5. Real Pi deterministic provider tests for child tool→pipe→manager→idle/busy recipient, no recursive tools, slash payload safety and cleanup.
6. Typecheck/full suite, isolated tmux TUI exercise, self-reload and bounded GPT-6 Luna live test. Verify no leftover test processes.

## Verification — 2026-09-23

Implemented and checked on Linux:

- `npm run check` and `npm test`: all 93 tests passed.
- Both real-Pi peer RPC suites passed against the package's Pi 0.85.1 Node CLI and the installed Pi 0.87.1 bundled runtime. The latter exposed a `Socket({fd})` compatibility issue: the child now uses bounded asynchronous descriptor I/O under Bun, while Node retains native socket adoption.
- Isolated tmux 3.7c TUI: deterministic A-denied/B↔C ping-pong sequence passed at 140 columns, then again after `/reload` at 70 columns. Compact/expanded tool output and orderly exit were exercised; all six fixture children stopped.
- Parent `self_reload` activated all four new management tools and the updated policy without extension errors.
- Live `openai-codex/gpt-6-luna:high` A/B/C test, each with **only** `peer_send` and context files disabled: A's unlinked send rejected; B→C ping and C→B pong received; limit-1 counters survived disconnect/reconnect; excess send rejected; explicit B→C renewal enabled exactly one further received message without renewing C→B; sending to closed C rejected without resumption.
- Live process logs confirmed only `peer_send` calls, three received messages, and no extension errors. All three test children were closed and their link disconnected. Their combined Pi-reported cost was $0.0021873 (test children only, not a billing guarantee).

Local smoke artifacts were retained under `/tmp/pi-peer-tmux-BsB6Ml/` (`wide.txt`, `narrow.txt`, `expanded.txt`, `proof.json`, `live-proof.json`). Reproducible fixtures/tests are under `test/`; the temporary evidence directory is not part of the package.

Remaining limitations are intentional: no channels/boards, no cross-parent links, no automatic delivery replay, no model-read/answered guarantees, no exact cost enforcement and no sandbox. Cross-platform behavior beyond the tested Linux runtimes is unverified.
