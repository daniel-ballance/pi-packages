---
name: poteto-help
description: Help with p3stack in Pi. Enable the router with /p3stack on or pick a standalone skill. Type /skill:poteto-help with a question.
disable-model-invocation: true
---

# Poteto help

Answer the user's question about pstack, hand them a prompt they can send, and link the file the answer came from. For a help question, don't start the work. The user asked how, and a pstack run spends real tokens, so let them send the prompt.

A message that asks for work, such as "use pstack to fix this bug", is not a help question. If routing is on, follow the router. If it is off, honor an explicit skill request; tell the user `/p3stack on` enables routing for this session.

Read the file you route to before you quote it, and trust it when it disagrees with this map. The links here point into the installed package, which the user may not be able to open, so give the user the file's public copy: `https://github.com/daniel-ballance/pi-packages/blob/main/packages/p3stack/` followed by its path.

## Find a job

With `/p3stack on`, say the [request](../p3stack-mode/SKILL.md#routes) in your own words and name your target; the router picks the row. Or type the row's command, which works with routing on or off. A row marked (router: default) or (router: autonomous) is the router's choice only under that grant: set it with `/p3stack on default` or `/p3stack on autonomous`.

| Request | What to type or ask for |
| --- | --- |
| Small task: the exact edit in a named file, or one fact answered by reading one function | Ask directly; no skill needed. |
| Understand one existing subsystem or code path | `/skill:poteto-mode use the investigation playbook` |
| Onboard to a repository, or map it as a whole | `/skill:p3stack-mode use the onboard-brownfield playbook` |
| Find a fact outside the repository | [`/skill:research`](../research/SKILL.md) |
| Align on a design with the human present | [`/skill:grilling`](../grilling/SKILL.md) (router: default) |
| Design without an interview or explore design alternatives | [`/skill:architect`](../architect/SKILL.md) (router: autonomous) |
| Map a large effort with unresolved decisions | [`/skill:wayfinder`](../wayfinder/SKILL.md) (router: default) |
| Publish a tracker spec | [`/skill:to-spec`](../to-spec/SKILL.md) (router: default) |
| Split a spec into tracker tickets | [`/skill:to-tickets`](../to-tickets/SKILL.md) (router: default) |
| Plan a program of PRs | `/skill:poteto-mode use the multi-phase-plan playbook` |
| Execute an approved multi-PR plan with authority to merge | `/skill:poteto-mode use the autopilot-full playbook` |
| Execute an approved multi-PR plan through verification; the operator lands the PRs | `/skill:poteto-mode use the autopilot-stack playbook` |
| Prototype a design to compare, try, or show someone | `/skill:poteto-mode use the prototype playbook` |
| Match an existing UI pixel for pixel | `/skill:poteto-mode use the visual-parity playbook` |
| Build new or changed behavior | `/skill:poteto-mode use the feature playbook` |
| Fix a reported bug without a failing reproduction | [`/skill:diagnosing-bugs`](../diagnosing-bugs/SKILL.md) |
| Fix a bug with a failing reproduction | `/skill:poteto-mode use the bug-fix playbook` |
| Diagnose a recorded trace, profile, or heap snapshot | `/skill:poteto-mode use the trace-forensics playbook` |
| Diagnose a running process by capturing a live profile or trace | `/skill:poteto-mode use the runtime-forensics playbook` |
| Investigate measured slowness when a timing or throughput number is given | `/skill:poteto-mode use the perf-issue playbook` |
| Improve one measured metric repeatedly | `/skill:poteto-mode use the hillclimb playbook` |
| Restructure code without changing behavior | `/skill:poteto-mode use the refactoring playbook` |
| Review my change | `/skill:p3stack-mode use the review-local playbook` |
| Clean up comments in a change | [`/skill:code-review`](../code-review/SKILL.md) using [no-comments](../code-review/references/no-comments.md) |
| Review someone else's PR | [`/skill:dyl-review`](../dyl-review/SKILL.md) |
| Triage incoming issues or external PRs | [`/skill:triage`](../triage/SKILL.md) |
| Open a PR | `/skill:poteto-mode use the opening-a-pr playbook` |
| Drive an existing PR to readiness | `/skill:poteto-mode use the babysit playbook` |
| Land a verified stack when authorized | `/skill:poteto-mode use the shipping playbook` |
| Set or audit the project's quality bar | [`/skill:constraints`](../constraints/SKILL.md) |
| Harden or threat-model a change | [`/skill:security-hardening`](../security-hardening/SKILL.md) |
| Add telemetry, metrics, or alerts | [`/skill:instrumentation`](../instrumentation/SKILL.md) |
| Survey codebase health | [`/skill:improve-codebase-architecture`](../improve-codebase-architecture/SKILL.md) |
| Implement a tracker ticket graph | [`/skill:implement-spec`](../implement-spec/SKILL.md) |
| Run one job until a checkable condition holds | `/skill:poteto-mode use the autonomous-run playbook` |
| Run a standing program of PRs | `/skill:poteto-mode use the orchestrate playbook` |
| Hand work to another tool or person | [`/skill:handoff`](../handoff/SKILL.md) |
| Pause the current session | `/skill:poteto-mode use the pause-safely playbook` |
| Resume an existing session | `/skill:poteto-mode use the session-pickup playbook` |
| Review the session's environment | [`/skill:retro`](../retro/SKILL.md) |
| Write or change a skill | `/skill:poteto-mode use the authoring-a-skill playbook` |
| Prepare steps only a human can perform | [`/skill:wizard`](../wizard/SKILL.md) |
| Audit and clean up stale worktrees or simulator data | `/skill:poteto-mode use the worktree-cleanup playbook` |
| Evaluate an agent or instruction change in a blinded experiment | `/skill:poteto-mode use the eval playbook` |
| Cut a release | [`/skill:release`](../release/SKILL.md) |
| Audit p3stack pins, refresh its upstream sources, or revert a p3stack maintenance PR | [`/skill:maintain-p3stack`](../maintain-p3stack/SKILL.md) |
| Handle a task with no matching playbook | [`/skill:figure-it-out`](../figure-it-out/SKILL.md) |

### Other standalone jobs

- Try the same task several ways and combine the best parts — [`/skill:arena`](../arena/SKILL.md)
- Check whether a measured speedup is real — [`/skill:benchmark-checklist`](../benchmark-checklist/SKILL.md)
- Check a diff against the spec and the repository's standards — [`/skill:code-review`](../code-review/SKILL.md)
- Find the mistakes agents keep repeating in this repo and make each one impossible — [`/skill:correct`](../correct/SKILL.md)
- Model-check a race or invariant, or audit the existing model — [`/skill:create-formal-verification-skill`](../create-formal-verification-skill/SKILL.md)
- Give agents a way to drive the app, or audit its existing verification skill — [`/skill:create-verification-skill`](../create-verification-skill/SKILL.md)
- Build and sharpen a project's domain model — [`/skill:domain-modeling`](../domain-modeling/SKILL.md)
- Explain how a code path works or where new code belongs — [`/skill:how`](../how/SKILL.md)
- Build something I can click to compare designs — [`/skill:interactive-prototype`](../interactive-prototype/SKILL.md)
- Have independent reviewers challenge a diff or design — [`/skill:interrogate`](../interrogate/SKILL.md)
- Catch me up on this chat and list what needs my decision — [`/skill:ketchup`](../ketchup/SKILL.md)
- Map an existing repository without code changes — [`/skill:onboard-brownfield`](../onboard-brownfield/SKILL.md)
- Turn on routing for this session — [`/p3stack on`](../p3stack-mode/SKILL.md)
- Help with p3stack in Pi — [`/skill:poteto-help`](../poteto-help/SKILL.md)
- Use poteto's workflow and response style for one task — [`/skill:poteto-mode`](../poteto-mode/SKILL.md)
- Write the PR description — [`/skill:pr`](../pr/SKILL.md)
- Reconstruct where I left off across recent chats — [`/skill:recall`](../recall/SKILL.md)
- Configure this repo for the engineering skills: set up its issue tracker, triage label vocabulary, and domain doc layout — [`/skill:setup-matt-pocock-skills`](../setup-matt-pocock-skills/SKILL.md)
- Configure which models pstack uses per role and at what reasoning budget — [`/skill:setup-pstack`](../setup-pstack/SKILL.md)
- Check an implementation choice against the official docs — [`/skill:source-grounding`](../source-grounding/SKILL.md)
- Check a state model and draw the paths that break its rules — [`/skill:statechart`](../statechart/SKILL.md)
- Split checks across workers and give me one report — [`/skill:swarm`](../swarm/SKILL.md)
- Fix a bug test-first with a cheap local reproduction — [`/skill:tdd`](../tdd/SKILL.md)
- Write or revise a README, RFC or commit message — [`/skill:technical-writing`](../technical-writing/SKILL.md)
- Trace why a design or threshold was chosen — [`/skill:why`](../why/SKILL.md)
- Write or edit instructions an agent will follow — [`/skill:writing-for-agents`](../writing-for-agents/SKILL.md)

### References by owner

Ask the owner for the named procedure. For a decision log, ask to read the reference itself.

- [architect](../architect/SKILL.md): [codebase-design](../architect/references/codebase-design.md), [sharpen](../architect/references/sharpen.md), [typescript-best-practices](../architect/references/typescript-best-practices.md)
- [code-review](../code-review/SKILL.md): [blast-radius](../code-review/references/blast-radius.md), [no-comments](../code-review/references/no-comments.md)
- [create-formal-verification-skill](../create-formal-verification-skill/SKILL.md): [maintain-formal-verification-skill](../create-formal-verification-skill/references/maintain-formal-verification-skill.md)
- [create-verification-skill](../create-verification-skill/SKILL.md): [maintain-verification-skill](../create-verification-skill/references/maintain-verification-skill.md)
- [dyl-review](../dyl-review/SKILL.md): [dyl-mode](../dyl-review/references/dyl-mode.md), [thermo-nuclear-code-quality-review](../dyl-review/references/thermo-nuclear-code-quality-review.md), [thermo-nuclear-review](../dyl-review/references/thermo-nuclear-review.md), [thermos](../dyl-review/references/thermos.md)
- [grilling](../grilling/SKILL.md): [in-your-own-words](../grilling/references/in-your-own-words.md)
- [how](../how/SKILL.md): [teach](../how/references/teach.md)
- [implement-spec](../implement-spec/SKILL.md): [implement](../implement-spec/references/implement.md)
- [p3stack-mode](../p3stack-mode/SKILL.md): [show-me-your-work](../p3stack-mode/references/show-me-your-work.md)
- [poteto-mode](../poteto-mode/SKILL.md): [principle-*](../poteto-mode/SKILL.md#principles)
- [retro](../retro/SKILL.md): [reflect](../retro/references/reflect.md)
- [tdd](../tdd/SKILL.md): [regression-test](../tdd/references/regression-test.md)
- [technical-writing](../technical-writing/SKILL.md): [bro](../technical-writing/references/bro.md), [unslop](../technical-writing/references/unslop.md)

## Find out what they need

Infer the need from the message and the conversation. A named situation, such as "which skill reviews a PR?", goes straight to its section. If the need is still unclear, ask one multiple-choice question with these options, then answer only the section they pick:

- Get set up
- Start a task with `/p3stack on`
- Find the skill or playbook for a job
- Fix a run that went wrong
- Make pstack my own

Check the state that changes the answer, and mention it only when it does:

- Without a valid [role defaults file](../poteto-mode/references/host-capabilities.md#models-and-role-defaults), p3stack resolves each skill's model hint against the available catalog.
- No `verify-*` skill or other app harness in the project means agents have no scripted way to drive the app. Mention `/skill:create-verification-skill` when the question is about proving a change works.
- No formal verification skill in the project means no property is checked past what tests reach. Mention `/skill:create-formal-verification-skill` when the question is about a race, an invariant, or another case tests rarely hit. When one exists and the code it covers changed after the commit it records as last in sync, recommend `/skill:create-formal-verification-skill` with a request to audit the existing model if the question touches that code.

When the role defaults file is missing and it matters, ask whether the user wants to pick a model for each role and a reasoning budget now. It matters when the user is new, the question is about setup or cost, or the answer depends on which models run. Ask at most once per chat. If the need is also unclear, ask both questions together. Offer two choices:

- Now: give them `/skill:setup-pstack` to type, and answer their question too.
- Later: answer their question, and add one line saying every role keeps its default model until they run `/skill:setup-pstack`.

## Get set up

1. The collection installs p3stack with `subagents` and `todo`. To install p3stack alone from a pi-packages checkout, run `pi install ./packages/p3stack` at the repository root, then `/reload`.
2. Run [`/skill:setup-pstack`](../setup-pstack/SKILL.md). It asks for a thinking budget and writes your choices to the [role defaults file](../poteto-mode/references/host-capabilities.md#models-and-role-defaults). Skills use them on their next delegation. Then it offers once each to generate a verification skill and a formal verification skill for the project, unless the project already has one.
3. Type `/p3stack on`, then send a goal and a check that can pass or fail.

Pi can select model-visible skills from the request even with the router off. Use `/skill:<name>` to request any installed skill explicitly. The [README](../../README.md) has the details, and upstream's [guide page 1](https://github.com/cursor/plugins/blob/3dbd22ff12742fb28c9700b9760baa29ed41dc13/pstack/docs/guide/01-setup.md) explains the ideas (written for Cursor). Offer to word their first prompt with them, per [`references/prompting.md`](references/prompting.md).

If cost is the worry, say where the tokens go and how to spend fewer. p3stack spends extra tokens on subagents and review panels. Rerun `/skill:setup-pstack` and pick a smaller budget or cheaper models. A role set to `auto` or `inherit-parent` runs on the chat's model, which costs less if the chat model is cheaper than the role default. A shorter panel list runs fewer subagents, one for each entry. Save `/skill:poteto-mode` for work that needs rigor.

p3stack runs in Pi, in a terminal or launched by T3 Code. Skills that delegate (`/skill:poteto-mode`, `/skill:how`, `/skill:why` and the routed skills) need a delegation backend: the `subagents` package in a terminal, T3's own tools under T3. The [host capabilities](../poteto-mode/references/host-capabilities.md) list what each host provides and what a skill does when a capability is missing.

## Start a task in Pi

Type `/p3stack on default` to enable the [router](../p3stack-mode/SKILL.md) with the default grant. Bare `/p3stack on` keeps the last grant. Then send the goal and a check that can pass or fail. The router selects the skill or playbook; there is no need to prefix every task. Under the default grant the agent asks about product choices. Use `/p3stack on autonomous` for the other grant: the agent makes covered choices and reports them. Explicit operator gates and irreversible actions still pause.

Type `/p3stack off` to turn the router off. For one skill with the mode off, use `/skill:<name>`, for example `/skill:how`. To help word the task, read [Word the prompt](references/prompting.md).

## Former names and close calls

For the former grill-with-docs interview, use `/skill:grilling` and record decisions with `/skill:domain-modeling`. For ketchup-video, `/skill:ketchup` gives a text recap; it does not render video. For automate-me, use `/skill:writing-for-agents` to write a personal skill from a workflow you specify. For principles, see the [poteto-mode index](../poteto-mode/SKILL.md#principles).

Close calls:

- `/skill:how` explains what the code does. `/skill:why` explains the reasons. Ask `/skill:how` for its teach walkthrough to combine the findings in plain language.
- `/skill:arena` gives every worker the same brief and merges the best parts. `/skill:swarm` splits work into slices or a race and returns one report.
- `/skill:architect` returns a design unless you assign it implementation. Add "with checkpoint" to review the design before it writes code.
- `/skill:interrogate` reviews the diff. Ask `/skill:code-review` for blast-radius to check what could break outside the diff.
- `/skill:recall` rebuilds context across recent chats. `/skill:ketchup` covers only this chat since the user's last message. Resuming one specific chat or branch is the Session pickup playbook.
- `/skill:figure-it-out` designs one rigorous run. The Orchestrate playbook runs a program that spans days and many PRs. The Autonomous run playbook drives one task to a finish condition.

Not in pstack:

- For AI writing tells, ask `/skill:technical-writing` to apply [unslop](../technical-writing/references/unslop.md). To drive the app, use the project's own driver (**Drive the app** in the [host capabilities](../poteto-mode/references/host-capabilities.md)).
- Cursor's loop command maps to **Wake and loop**, and its skill-authoring built-in to `writing-for-agents` and the pi-packages repository's `lint-skill` (`scripts/lint-skill`).
- pstack has no `/orchestrate` skill. Orchestrate is a `/skill:poteto-mode` playbook. If the slash menu shows `/orchestrate`, another package provides it.

## Playbooks and principles

Playbooks are procedures, not slash commands. With the router on, describe the task. For example:

- "babysit this pr" or "check on pr 123" runs Babysit. It drives the PR to merge-ready and stops there. It doesn't merge unless the user asks to merge, land, or ship.
- "land the stack" runs Shipping.
- "take over this branch" runs Session pickup.
- "pause safely" runs Pause safely.
- "run the approved plan and merge each verified PR" runs Autopilot-full. "autopilot, don't merge" runs Autopilot-stack.
- "run the eval playbook" runs Eval.

The [Pi router](../p3stack-mode/SKILL.md#routes) maps each routed request and grant to a first skill or playbook. [Guide page 6](https://github.com/cursor/plugins/blob/3dbd22ff12742fb28c9700b9760baa29ed41dc13/pstack/docs/guide/06-verify-and-ship.md) covers opening, babysitting, and landing a PR.

With routing on, asking for a multi-PR plan runs the [Multi-phase plan playbook](../poteto-mode/playbooks/multi-phase-plan.md), which writes the plan and doesn't implement it. For a design question, the router reads `/skill:grilling` with the human present or `/skill:architect` under full autonomy.

Principles are references that `/skill:poteto-mode` reads before citing them. Ask for one by title, as in "apply prove it works. show me the real output." [Guide page 8](https://github.com/cursor/plugins/blob/3dbd22ff12742fb28c9700b9760baa29ed41dc13/pstack/docs/guide/08-principles.md) lists them.

## Fix a run that went wrong

| Symptom | Fix |
|---|---|
| The mode stopped applying after a few turns | Check `/p3stack status`. Use `/p3stack on` to enable routing in this session. |
| A question got treated as the next step of the last task | Say "new task", or say the turn doesn't need the mode. |
| A new model choice had no effect | Skills read the role defaults on each delegation. Check the file `/skill:setup-pstack` wrote. |
| Runs cost more than expected | See the cost paragraph under Get set up. |
| A skill didn't load on its own | Pi can select model-visible skills from the request even with the router off. Use `/skill:<name>` to request any installed skill explicitly. |
| Parallel agents overwrote each other | Give each agent its own worktree (**Isolation** in the host capabilities). |
| An overnight run moved but finished nothing | A wake loop needs a check that can pass or fail, not a duration. See [guide page 7](https://github.com/cursor/plugins/blob/3dbd22ff12742fb28c9700b9760baa29ed41dc13/pstack/docs/guide/07-overnight.md). |
| The reply claims success from a green build | Ask for the real command, flow, stored value, or profile. That's the prove-it-works principle. |

For a run that drifts, [`references/prompting.md`](references/prompting.md) has one-line steers. [Guide page 10](https://github.com/cursor/plugins/blob/3dbd22ff12742fb28c9700b9760baa29ed41dc13/pstack/docs/guide/10-recipes-and-pitfalls.md) has more pitfalls and the recipes worth copying.

## Make pstack my own

- Ask `/skill:retro` for [reflect](../retro/references/reflect.md) to turn session lessons into skill edits you approve.
- `/skill:poteto-mode write a skill for <workflow>` runs the authoring playbook. The eval playbook tests a skill change blind.
- Fix a misbehaving skill in its own PR, not inside the feature work where it went wrong.

[Guide page 9](https://github.com/cursor/plugins/blob/3dbd22ff12742fb28c9700b9760baa29ed41dc13/pstack/docs/guide/09-make-it-yours.md) covers each of these.

## Reply

Lead with the answer. Give at most one example prompt in a code block, adapted from [`references/recipes.md`](references/recipes.md) when one fits, then the link to that file. Keep it short unless the user asked for the whole map.
