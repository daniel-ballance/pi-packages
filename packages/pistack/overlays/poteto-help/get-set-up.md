## Get set up

1. Install with `pi install <path or git URL of pistack>`, then `/reload`. pistack is its own package, not part of the collection manifest.
2. Run [`/skill:setup-pstack`](../setup-pstack/SKILL.md). It asks for a thinking budget, maps a model to each role, and writes `~/.pi/agent/pistack.json`. Skills read it on their next delegation.
3. Start a real task with `/skill:poteto-mode`, a goal, and a check that can pass or fail.

Installing changes nothing until the user invokes a skill. Only `/skill:setup-pstack` loads from the user's words. The [README](../../README.md) has the details, and upstream's [guide page 1](https://github.com/cursor/plugins/blob/{{upstream.commit}}/pstack/docs/guide/01-setup.md) explains the ideas (written for Cursor). Offer to word their first prompt with them, per [`references/prompting.md`](references/prompting.md).

If cost is the worry, say where the tokens go and how to spend fewer. pistack spends extra tokens on subagents and review panels. Rerun `/skill:setup-pstack` and pick a smaller budget or cheaper models. A role set to `auto` or `inherit-parent` runs on the chat's model, which saves tokens when the chat runs on a cheaper model. A shorter panel list runs fewer subagents, one for each entry. Save `/skill:poteto-mode` for work that needs rigor.

pistack runs in Pi, in a terminal or launched by T3 Code. Skills that delegate (`/skill:poteto-mode`, `/skill:how`, `/skill:why`, `/skill:teach` and the routed skills) need a delegation backend: the `subagents` package in a terminal, T3's own tools under T3. The [host capabilities](../poteto-mode/references/host-capabilities.md) list what each host provides and what a skill does when a capability is missing.
