---
name: reflect
description: Spawn three parallel review subagents over the active transcript, surface learnings, and route each to a concrete edit on an existing skill. Use when the user says reflect.
disable-model-invocation: true
---

# Reflect

Mine the current conversation for durable learnings, then route them into skill edits.

Invoke when the user says "reflect" or "/skill:reflect". Skip when the conversation is trivial, off-topic, or already covered by an existing skill the parent followed correctly. One-offs are not learnings.

## 1. Locate the active transcript

Before fanning out, find this conversation's Pi session file in this project's session directory (**Session history** in the [host capabilities](../poteto-mode/references/host-capabilities.md)). Never read other projects' sessions.

```bash
ls -t <session-dir>/*.jsonl 2>/dev/null | head -10
```

Pi writes one file per session. Its first line is a `session` header; conversation turns are `message` entries. For each candidate, find the first `message` entry whose `message.role` is `user`, and take the file whose text contains the conversation's opening user prompt. Forks and clones share that prompt, so when several match, take the newest. One file can hold several branches: follow `parentId` back from the latest entry and read only that branch. If none matches, pass a tight digest of the session instead.

## 2. Spawn three reviewers in parallel

Delegate three reviewers at once per **Delegate** in the [host capabilities](../poteto-mode/references/host-capabilities.md), each with the MCP tools it needs: reviewers look up the tickets, chat threads, and observability traces the transcript references.

Each reviewer and the synthesizer name a role in the role defaults and a default. Use that role's model, or the default if no role default is set. For `auto` or `inherit-parent`, use your own model (**Parent model** under **Delegate**). Resolve the model per **Models and role defaults** in the [host capabilities](../poteto-mode/references/host-capabilities.md). If the catalog does not offer it, use the default and say so; if it does not offer the default either, follow that section's fallback. Pick each subagent's reasoning level for the job, per the Subagents section of the **poteto-mode** skill.

| Lens | Role line | Default `model` | Prompt template |
|---|---|---|---|
| Judgment | `reflect judgment, divergent, synthesizer` | `claude-opus-5-5-xhigh` | `references/judgment-reviewer.md` |
| Tooling | `reflect tooling` | `grok-4.7-xhigh-fast` | `references/tooling-reviewer.md` |
| Divergent | `reflect judgment, divergent, synthesizer` | `claude-opus-5-5-xhigh` | `references/divergent-reviewer.md` |

Pass each template verbatim, substituting the transcript path or digest where marked. Reviewers return findings in their final report.

## 3. Synthesize

Delegate one child on the `reflect judgment, divergent, synthesizer` role (default `claude-opus-5-5-xhigh`), with the MCP tools it needs: it spot-verifies citations through MCP. Pass `references/synthesizer.md` verbatim, with each reviewer's full output inlined where marked. It returns an Accepted / Rejected / Backlog list.

## 4. Structural enforcement check

Move any Accepted item that a lint rule, script, metadata flag, or runtime check would enforce more reliably to Backlog. See the **encode-lessons-in-structure** principle skill.

## 5. Apply

Present the synthesizer's full Accepted / Rejected / Backlog output and wait for explicit approval before applying any Accepted edit. The user picks the subset and may redirect routings. Skill changes affect every future agent in the org. Do not auto-apply.

File each Backlog item to your team's devex or backlog tracker without waiting. Only the Accepted list waits for approval.

Follow each approved row's Routing exactly:

- Trivial existing-skill edit (a one-line bullet, a tightened sentence, a stale fact corrected): the parent does it directly.
- Substantive existing-skill edit (a new section, a new pattern table, more than ~10 lines): hand to the skill-authoring procedure (**Author a skill** in the host capabilities) and run its draft, test and iterate loop.
- `tune description: <skill path>` (the skill exists but didn't trigger when it should have): revise the description and rerun the trigger test from **Author a skill**.
- `new skill: <kebab-name>`: create it per **Author a skill**. Do not invent the shape ad hoc.

If your environment ships a SKILL.md validator, run it on every touched skill before declaring done.

## 6. Summarize for the user

Short list, no preamble:

- Edits applied: `<skill path>`. What changed, one line each.
- New skills created: `<skill path>`. One line each (rare).
- Backlog filed to the devex tracker: `<issue title>` (`<tags>`). One line each.
- Dropped: one line per rejected finding + reason from the synthesizer.
