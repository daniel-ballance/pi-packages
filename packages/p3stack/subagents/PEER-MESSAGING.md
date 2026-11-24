# Peer messaging: design and verification

## Scope

Parent-authorized, bidirectional, non-transitive links between children tracked by one manager. A ↔ B and B ↔ C do not authorize A ↔ C. Peer permission grants neither management proxies nor approval authority. No broadcast, channel or polling inbox.

## API and policy

Activate deferred management tools with `subagent_catalog({activate:[name]})` or find them with `tool_search`.

- `peerMessageLimit`: policy ceiling (integer 0–1000, omitted/default 0 disables). `peer_send` must also be allowlisted and explicitly selected by both children.
- Parent `subagent_connect({a,b,limit})`: create a link with independent allowances in both directions. Reconnecting retains counters and limits; omit limit for reconnect. Repeating a connection never renews it. Optional `introduce:true` sends each child its peer's identity and task; that can start two billable turns, and uncertain delivery is not retried.
- Parent `subagent_disconnect({a,b})`: reject subsequent sends. Already submitted messages cannot be retracted.
- Parent `subagent_renew({sender,recipient,limit})`: replace that direction's allowance with a new generation, explicitly resetting its used count; lifetime total retained. No renewal while that direction has a submission in flight.
- Parent `subagent_peers({id?,since?})`: inspect links and paginated bounded message history without acknowledging ordinary reports.
- Child `peer_send({recipient,message})`: point-to-point text, max 4000 characters; returns message ID, delivery status and remaining allowance. No model-supplied sender identity or management operations.

Existing policies do not gain communication permissions. With peer messaging disabled, the four parent tools are not registered. Reloading with a different policy does not erase saved links or history.

## Transport and delivery

An extra inherited duplex pipe connects each opted-in child to its manager. The manager binds identity to the child process, not request text. No listening port, shared secret or discovery file. This is not an OS sandbox: unrestricted bash/trusted extensions retain host privileges.

Use RPC `prompt` with `streamingBehavior: steer` for every peer delivery: Pi queues it at the next tool boundary when working and starts a turn when idle, resolving the working→idle race inside Pi. Wrap the body in a manager-generated attributed envelope, explicitly identifying it as untrusted peer work output, not user instructions/permissions; a leading slash in the body cannot invoke a command.

Reject self/unlinked/unknown recipients, starting/stopping/stopped/failed/waiting-for-input children, abort-in-progress and unavailable capability. Never restart a process or answer human dialogs. Replying requires an explicit `peer_send`; ordinary assistant output remains parent-visible.

## Accounting and recovery

Reserve and persist a directional slot before any asynchronous delivery. Concurrent sends cannot overspend. Definitive RPC rejection refunds the slot; unknown acceptance (timeout/exit) retains it. No automatic retries/replay. Accepted means RPC accepted/queued, not model success. On Pi runtimes that report input disposition, the peer history retains it. `handled` means an extension consumed the envelope without an observed receipt; it retains its allowance (the extension may have side effects), survives recovery, and is not automatically retried. A matching user-message event marks `received` (entered conversation, not proof of model reading/answering). Aborting/closing/reload can discard queued messages; retained counts do not reset. Unconfirmed deliveries become `interrupted` across recovery, never implicitly redelivered.

Links and allowance generations persist with the manager registry. Message bodies/history are bounded to 200 entries (pagination and gap indication); counters/lifetime totals persist beyond history eviction. Pending submissions are not evicted. Stable message IDs identify records. Rejected preflight attempts are tool errors, not durable messages. Ordinary peer traffic does not itself create parent notifications; child completion/error/input reporting keeps its existing semantics.

## Verification

Run `npm run check` and `npm test` in this package. The peer broker, transport and RPC suites exercise pair authorization, directional accounting, idle/busy delivery, interruption and recovery. A historical Linux check (2026-09-23) also exercised the Bun descriptor path on installed Pi 0.87.1; this is not verification of other runtimes or platforms.
