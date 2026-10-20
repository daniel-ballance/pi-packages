# Onboard to a brownfield repository

Build a written map of the existing repository. Keep the repository read-only. Write evidence and reports outside the checkout. Apply each linked skill within that scope. Return proposed repository files in the answer instead of writing them. Preserve the starting working tree, including existing user changes. Leave implementation, configuration edits, tracker writes, and refactors for a separate task.

Resolve the links below from the `skills/p3stack-mode/` directory, not its `playbooks/` subdirectory. Read each linked `SKILL.md` in full before following its procedure.

Keep a checklist with the steps below. Retain skipped steps with the reason. Complete each numbered step before loading the next step's skill.

## 1. Establish the tracker

Record `git status --short` as the baseline. Inspect the README, agent instructions, `docs/agents/issue-tracker.md`, remotes, and any documented local tracker. A documented local Markdown tracker counts as an existing tracker. A remote alone is not proof that issues are enabled.

If a tracker exists, read [setup-matt-pocock-skills](../setup-matt-pocock-skills/SKILL.md) as the first workflow skill, even when its configuration already exists. Complete its discovery and configuration assessment before reading `how` or `create-verification-skill`. Reuse existing tracker decisions and return any missing configuration as a draft. Keep labels and repository files unchanged.

If no tracker exists, mark this setup step skipped with the evidence. Continue without creating a tracker.

Finish with the tracker location and setup assessment, or the reason for the no-tracker skip, in the checklist.

## 2. Explain the top-level architecture

Read [how](../how/SKILL.md) and follow its procedure on the top-level architecture. Trace an actual user entry point through the main modules to storage or external systems. Identify the build and test commands from the repository itself. Cite the paths that support each relationship.

Use the host's read-only delegation capability when available. If delegation is unavailable, perform the exploration and synthesis yourself and state that limitation.

Finish with the entry points, module responsibilities, dependency direction, and one traced runtime flow.

## 3. Establish verification

Read [create-verification-skill](../create-verification-skill/SKILL.md) and follow its procedure. Interview the repository for its launch, drive, observe, and isolation paths. Use an existing verification skill when one already covers the primary user path.

Keep proposed verification files in the answer for this read-only run. Exercise one user path only when it can run without repository or shared-state changes. Save the command and its output in an evidence file outside the checkout. If startup needs an install, migration, credential, or other write, report the exact blocker instead of repairing the repository. Label an unexecuted verification recipe as a draft.

Finish with the verification recipe, evidence path, and any unproven steps.

## 4. Check the domain model under the grant

Under full autonomy, run [domain-modeling](../domain-modeling/SKILL.md) without asking for permission. Resolve observable terminology from the code and existing domain docs. Label unresolved product meanings as assumptions.

Under the default grant, ask whether to run the domain-modeling pass before proceeding. If the user declines, keep the step as skipped with that reason. If the user accepts, run the pass. If a reply is unavailable, pause at this gate and return the map so far.

Keep resolved terms, contradictions, and proposed glossary entries in the answer. The read-only scope also applies to `CONTEXT.md` and ADRs.

Finish with a domain vocabulary draft or an explicit skipped step.

## 5. Survey architecture health

Read [improve-codebase-architecture](../improve-codebase-architecture/SKILL.md) and follow its survey procedure using the architecture map, domain vocabulary, and recent change history. Produce its HTML candidate report outside the checkout. If no candidates have evidence, write a report that records that finding rather than skipping the report. Record the report path in the map. Keep the strongest evidence-backed opportunities and distinguish speculation from observed friction.

Stop after the survey and recommendation. Leave candidate selection, the grilling loop, and implementation for a separate task.

## 6. Deliver the written map

End with a written map in the answer that includes:

- The repository's purpose and primary user entry points.
- The modules, dependency direction, and traced runtime flow, with source paths.
- The tracker and configuration drafts, or the skipped setup step.
- The verification commands, evidence, and unproven steps.
- The domain vocabulary and open meanings, or the skipped domain pass.
- The architecture report path and recommended follow-up work.

Compare `git status --short` with the recorded baseline. Report whether the working tree is unchanged. A pre-existing dirty tree stays dirty. A clean starting tree must finish clean. End with the map and proposed next tasks, not a code change or a commit.
