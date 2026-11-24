# t3-agent

Tunes Pi for [T3 Code](https://github.com/pingdotgg/t3code). With this package, Pi knows what the T3 user sees, which permission mode is in force, and what Git reports about the checkout. It can call the T3 tools it needs without a search round trip, and it keeps track of the T3 objects it creates.

**It does nothing unless T3 launched Pi.** T3 sets `T3_MCP_URL` for the Pi processes it starts; the shared host helper ([`shared/host.ts`](../../shared/host.ts)) reads it. In a terminal the extension returns before it registers anything: no tools, commands, prompt text, skills or prompt templates.

## How it relates to T3's bridge

T3 injects its own extension into every Pi it launches. The bridge owns the MCP connection, registers the T3 tools as `mcp__t3-code__<name>`, normally declares three of them (`orchestrator_capabilities`, `delegate_task`, `task_status`) and defers the rest, activates more when its discovery or provider requires it, applies the permission mode through Pi's `tool_call` hook, and appends its orchestration guidance. t3-agent builds on that. It never opens its own connection or reads the bearer token, and it adds no tool of its own.

## What it adds under T3

**A `t3_agent` prompt section** (about 2 KB) that states what the bridge's guidance leaves out:

- T3 renders bash calls as command cards and edits as diffs, so the reply should not repeat them.
- Waiting for T3 means ending the turn on a wake, not leaving an agent polling after the reply.
- Codemode scripts batch tool calls with `Promise.allSettled` and read only paths known to exist. Twice, a script whose `Promise.all` rejected on a missing file while its other reads were running ended the Pi process, and T3 reported the turn as failed ("Pi process exited unexpectedly"). The cause inside Pi is not isolated, so the prompt tells the model to avoid the pattern.
- The permission mode from `T3_PI_RUNTIME_MODE`. In supervised and auto-accept-edits threads, `read`, `grep`, `find`, `ls` and read-only T3 tools are exempt from bridge approval, so the model is told to search with them and to batch shell commands.
- The workspace: repository root, branch, upstream, default branch, and whether Git reports a linked worktree under T3's worktree directory. Work in such a worktree is already off the main checkout; other threads or delegates may be using it too.
- Pi has no native subagent tool under T3, so wherever T3's guidance says "your native tool", Pi uses `delegate_task`.
- The open T3 handles, described below.

The section is rebuilt before each prompt. Git checks the checkout, branch, upstream and origin/HEAD again; the worktree listing is reused while the checkout paths match. Pi can resend changed sections to providers that support mid-conversation system messages.

**A T3 tool loadout.** The model can discover deferred tools with `tool_search` or call known ones in codemode. A loadout activates a chosen set up front. Codemode-only can hide declarations without deactivating the tools:

| Loadout | Activates |
| --- | --- |
| `lean` | No preset additions to the bridge's tools |
| `standard` (default) | Also `task_cancel`, `t3_thread_read`, `request_secret`, `html_preview`, `html_render`, `watch_pull_request`, `schedule_task`: the tools T3's guidance tells the model to call |
| `full` | Every T3 tool |

Open handles add the tools that act on them: `t3_preview_close` while a preview tab is open, `unwatch_pull_request` while a PR is watched, `delete_scheduled_task` while a schedule exists, and `device_close` and `device_screenshot` while a device is open. These tools are withdrawn when the handle closes. In supervised and auto-accept-edits threads the loadout also activates Pi's built-in `grep`, `find` and `ls`. The bridge never asks before those, while every bash call needs approval. The package records its own additions on the current session branch. It never withdraws pre-existing or bridge-required tools, including the eager loadout for completion gateways.

**A ledger of T3 handles.** It reads the results of T3 tools, including calls made from codemode scripts, and records:

- delegated tasks: from `delegate_task`, and from `t3_thread_send` to a finished child
- schedules
- watched pull requests
- launched threads
- preview tabs
- devices

Terminal task results, confirmed schedule deletions, PR unwatches, tab and device closes remove open handles. A pending cancel stays open as cancelling; disabling a schedule keeps it open as paused. Device identities include the host ID when known. Updates are saved as custom session entries at each turn boundary, so the ledger follows `/tree` branches and survives restarts. It is rendered into the prompt section, so the long ids that `task_cancel` and `t3_preview_close` need survive compaction.

Receipts belong to the recording Pi session. When a local T3 result identifies the caller's thread or environment, new receipts also carry those IDs; replay withholds them until the observed IDs match. A fork does not inherit the parent's receipts. Legacy entries with no session ID replay only in unforked sessions. For an explicit target outside the known caller scope, `/t3-agent ledger` shows the handle with a qualified ID. It never supplies that handle as local work to the prompt, loadout or tab reminder. A remotely delegated task's ID still belongs to the calling parent.

Rewinding Pi does not rewind T3. To check a stale observation, ask for that thread's preview tabs or PR watches, or for a schedule by ID. The ledger observes the requested native list result. A partial list cannot prove absence; schedule lists are project-filtered and can confirm paused/enabled state, not deletion. The extension never polls T3, reads a delegate result on your behalf, or closes anything to reconcile its ledger.

The ledger keeps bounded identifiers, caller-supplied titles, states and checked thread or pull request links. It drops legacy titles on replay. A PR is keyed by forge, repository and number; without a known public link format, its handle is `repository#number@host`. Older `owner/repo#number` watches keep their host unspecified. For an old self-hosted PR URL, the ledger shows a fingerprint, number and host rather than copying an unverified URL path. A later structured forge result matches that fingerprint. It does not copy task briefs, preview URLs, webhook URLs or free-form result details. Replay applies the same checks to older entries; it does not erase old transcripts. Use T3's schedule settings for webhook details.

**A preview-tab reminder.** T3's guidance says to close a preview tab you opened before replying. Only a confirmed new, caller-owned tab still open at settlement triggers one automated continuation per run. If the model closes the tab, Pi makes another request for its reply after the tool result. Reusing an existing tab does not claim it. Revisiting a tab this run created keeps the reminder unless a close or takeover was observed.

**Composer status.** T3 shows extension status near the composer. t3-agent publishes the mode, the loadout, and the counts of open delegates, schedules, watched PRs and tabs, for example `t3-agent: supervised · standard loadout · 2 delegates`.

**The `t3-code` skill** maps each job (child agents, threads, worktrees, PRs, schedules, secrets, charts, browser and device previews, attachments, projects) to the T3 tool that does it. It also states the rules no single tool description gives.

**Prompt templates** for T3 workflows, in the composer's `/` menu:

| Command | Does |
| --- | --- |
| `/t3-ship [notes]` | Run the checks, commit, push, open a PR, and link it to the thread |
| `/t3-babysit [url]` | Handle a PR's checks and reviews, watch it, and carry it to ready-to-merge across wakes |
| `/t3-review [focus]` | Get an async review from another model family through `delegate_task`, then verify each finding |
| `/t3-fanout <task>` | Split a task into disjoint parts, delegate each to its own worktree, then merge the results |
| `/t3-chart <question>` | Answer with a themed chart through `html_preview` and `html_render` |
| `/t3-handoff [branch]` | Move this thread into its own worktree with a continuation prompt |

The skill and templates are contributed through `resources_discover` only under T3. The package's static `skills/` and `prompts/` directories are empty.

## Commands

- `/t3-agent` or `/t3-agent status` reports the mode, loadout, active tools, workspace, open handles and configuration problems.
- `/t3-agent loadout lean|standard|full` sets this session's loadout. The choice is saved in the session.
- `/t3-agent ledger` lists open handles.
- `/t3-agent forget <id|all>` drops stale handles from the ledger (use `hostId/deviceId` for a scoped device, or the bracketed ID in the listing for another thread or environment). It changes nothing in T3.

## Configuration

Optional. `~/.pi/agent/t3-agent.json` (or under `PI_CODING_AGENT_DIR`) applies first, then `.pi/t3-agent.json` in a trusted project.

```json
{
  "loadout": "standard",
  "tools": ["t3_worktree_status", "link_pull_request"]
}
```

`loadout` is `lean`, `standard` or `full`. `tools` lists bare T3 tool names to activate beside the loadout. Bad values are ignored and reported once in the thread. `/t3-agent status` separately lists valid tool names not in the current catalog; it checks again each time, since T3 tools can load late.

## Install

The [root package](../../README.md#install-from-github) includes t3-agent. To install it alone:

```sh
pi install ./packages/t3-agent
```

Requires Pi 1.5.0 or newer.

## Develop

```sh
npm --prefix packages/t3-agent run check   # types and skill lint
npm --prefix packages/t3-agent test        # unit, extension and real Pi RPC tests, with and without T3_MCP_URL
```

The RPC test runs the real Pi CLI with a stand-in bridge and a deterministic provider. It checks that the section, the loadout and the ledger reach an actual model request.
