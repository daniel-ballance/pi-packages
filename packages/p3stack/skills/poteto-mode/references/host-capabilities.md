# Host capabilities

Use `Host: terminal` or `Host: t3` from the p3stack system prompt. Without it, choose T3 Code if tools named `mcp__t3-code__*` exist; otherwise choose terminal. Read the capability here and follow **only your host's link**. Check availability before use.

Resolve skill links from the poteto-mode skill directory. `<agent-dir>` is Pi's agent directory: `PI_CODING_AGENT_DIR` when set, otherwise `~/.pi/agent`.

## Delegate

Give each child a standalone brief: its goal, scope, limits and required evidence. Verify the result against the brief. If delegation is unavailable, do the work yourself only where independence is not required; report any missing independent verdict. Leave human-stopped work stopped.

**Parent model.** `auto` and `inherit-parent` mean your own model, if offered. Resolve the role under **Models and role defaults**. Dispatch in waves within the available live-child capacity.

- [Terminal](../poteto-mode/references/host-terminal.md#delegate)
- [T3 Code](../poteto-mode/references/host-t3.md#delegate)

## Models and role defaults

Call `p3stack_roles` for the skill's role. For a reviewer, judge or adversary, pass the author's model as `distinctFrom`. Use the returned selection for each seat. Report unresolved roles and relevant `problems`, including substitutions and missing diversity. A skill default is a hint; a model, provider or setting the user requested is a requirement. If unavailable, report it rather than substituting.

Without the resolver, read the first valid role file: `.pi/p3stack.json` in a trusted project, then `<agent-dir>/p3stack.json`. An absent role uses the skill's hint. Match defaults to the live catalog; report any role you cannot fill.

- [Terminal](../poteto-mode/references/host-terminal.md#models-and-role-defaults)
- [T3 Code](../poteto-mode/references/host-t3.md#models-and-role-defaults)

## Isolation

Use separate checkouts for independent writes. A new checkout contains committed work, not dirty edits. For uncommitted work, give reviewers read-only access to the scoped changes in place; report any they cannot inspect.

- [Terminal](../poteto-mode/references/host-terminal.md#isolation)
- [T3 Code](../poteto-mode/references/host-t3.md#isolation)

## Nesting

Keep fan-out with the parent unless a coordinator needs children and can manage them. A child unable to delegate reports any step it could not perform independently.

- [Terminal](../poteto-mode/references/host-terminal.md#nesting)
- [T3 Code](../poteto-mode/references/host-t3.md#nesting)

## Store

Keep off-repo state in `<agent-dir>/p3stack/--<path>--/`, with the cwd encoded as in **Session history**. Under that store, keep each run's briefs, reports and [execution ledger](../p3stack-mode/references/execution-ledger.md) in `runs/<run-id>/`. Retire the run directory after landing and promoting its rulings.

- [Terminal](../poteto-mode/references/host-terminal.md#store)
- [T3 Code](../poteto-mode/references/host-t3.md#store)

## Wake and loop

For authorized recurring work, set a trigger, stop condition and deadline. Stop on success, deadline or operator stop. For a child's result use **Delegate** instead.

- [Terminal](../poteto-mode/references/host-terminal.md#wake-and-loop)
- [T3 Code](../poteto-mode/references/host-t3.md#wake-and-loop)

## Ask the human

Use `ask_user` for a product or preference call no experiment can settle. If the tool is absent, ask in your reply. If it returns a default, state what you used; a default is not approval. Leave an unanswered approval gate pending. Never solicit credentials in chat or a brief.

- [Terminal](../poteto-mode/references/host-terminal.md#ask-the-human)
- [T3 Code](../poteto-mode/references/host-t3.md#ask-the-human)

## Todo

Track playbook steps in order. Mark omitted steps skipped with a reason. Without a task list tool, update a Markdown checklist in your reply.

- [Terminal](../poteto-mode/references/host-terminal.md#todo)
- [T3 Code](../poteto-mode/references/host-t3.md#todo)

## Fetch official docs

Verify against the project's pinned version. In Context7, resolve the library ID, select the version if listed and query one concept at a time. Otherwise fetch the specific official page; if its URL is unknown, search with `site:` on the official domain first. Cite the URL and version beside the code it justifies. Keep private code and credentials out of queries. If the version cannot be verified, say so.

- [Terminal](../poteto-mode/references/host-terminal.md#fetch-official-docs)
- [T3 Code](../poteto-mode/references/host-t3.md#fetch-official-docs)

## Read and search

Search for the symbol or path, then read the matching file and relevant callers.

- [Terminal](../poteto-mode/references/host-terminal.md#read-and-search)
- [T3 Code](../poteto-mode/references/host-t3.md#read-and-search)

## Drive the app

Use the project's verification skill or harness. For a prototype, check walkthroughs and free-play controls or each UI variant and its switcher through a permitted driver. Hand back the actual file path or URL; distinguish what you exercised from what remains unverified.

- [Terminal](../poteto-mode/references/host-terminal.md#drive-the-app)
- [T3 Code](../poteto-mode/references/host-t3.md#drive-the-app)

## Visuals

If image generation is unavailable, offer SVG, HTML or Mermaid and name the substitution. Distinguish an inline illustration from a file the human needs to reuse.

- [Terminal](../poteto-mode/references/host-terminal.md#visuals)
- [T3 Code](../poteto-mode/references/host-t3.md#visuals)

## Pull requests

Use the project's active forge for PR state. A status check is one observation. Watch only for an authorized babysit, and stop at its agreed end. Babysitting is not permission to merge.

- [Terminal](../poteto-mode/references/host-terminal.md#pull-requests)
- [T3 Code](../poteto-mode/references/host-t3.md#pull-requests)

## Session history

Pi parent sessions default to `<agent-dir>/sessions/--<path>--/*.jsonl`. Encode the absolute cwd by dropping the leading slash and replacing `/`, `\` and `:` with `-`. Honor overrides in order: `--session-dir`, `PI_CODING_AGENT_SESSION_DIR`, `sessionDir`. Check the session header's cwd before reading messages, especially in a shared directory. Follow `id`/`parentId` for the relevant branch; read only this project's in-scope history.

- [Terminal](../poteto-mode/references/host-terminal.md#session-history)
- [T3 Code](../poteto-mode/references/host-t3.md#session-history)

## Author a skill

Follow [writing-for-agents](../writing-for-agents/SKILL.md). Match the `SKILL.md` frontmatter name to its directory and resolve links from that directory. For a model-invoked skill, test the description against prompts that should and should not load it; for an explicit invocation, test the named command. Run live evaluations only with authorization.

- [Terminal](../poteto-mode/references/host-terminal.md#author-a-skill)
- [T3 Code](../poteto-mode/references/host-t3.md#author-a-skill)

## Run a workflow

When the template engine or required worker resources are unavailable, follow the skill's prose procedure. Report any required check you could not reproduce.

- [Terminal](../poteto-mode/references/host-terminal.md#run-a-workflow)
- [T3 Code](../poteto-mode/references/host-t3.md#run-a-workflow)
