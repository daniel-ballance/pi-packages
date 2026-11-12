# Matt Pocock bump on 2026-11-12

## Pins

- Source: `matt-pocock`, upstream `mattpocock/skills`.
- Checkout: `vendor/matt-pocock`, not shared.
- Old SHA: `4ae2317ddb22b046e26455e4f9c9b3aaaf62212d`.
- New SHA: `5863806dd4e15c63174bee4e7515a4256792ecfa`.
- [Upstream comparison](https://github.com/mattpocock/skills/compare/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d...5863806dd4e15c63174bee4e7515a4256792ecfa).
- [Maintenance PR](https://github.com/daniel-ballance/pi-packages/pull/123).

## Upstream scope

- One upstream commit, `d18183f` (merged as `5863806`, upstream PR #1416): "software-factory: \"job\" is the CI vendor's word; explore leaves findings".
- Changed mapped paths, both reported as dropped: `skills/in-progress/software-factory/SKILL.md` (the _Avoid_ line for **Task** now explains that a CI vendor's workflow file and jobs are where a task is wired up) and `skills/in-progress/software-factory/EXAMPLE-TASKS.md` (the explore task now reproduces ticket claims and leaves findings on the ticket).
- No path is marked review scope or borrowed. `rules/borrowed.json` has no `matt-pocock` entry. No packaging file outside the mapped subtree changed.

## Decisions

- No new, renamed, removed, or behavior-changing emitted skill. The existing registry row drops `skills/in-progress/software-factory/SKILL.md` with its reason (in-progress remote factory design is outside the supported maps). The edit is wording inside that dropped skill, so the verdict stands. No registry, token, section, patch, route, chain, or deny-token change.

## Generated changes

- Only the `matt-pocock` pin in the README upstream line moves to the candidate. No skill or agent output changed.
- The second generation produced a diff identical to the first (both empty).

## Verification

See the PR body for the gate results. The current-pins root gate, `generate.mjs --check`, the registry check (`0 unclassified`), the static T3 pin check, the loader check, and the fresh-process smoke with `--model claude-subscription/claude-sonnet-5-5:high` passed. Live T3 catalog check: `orchestrator_capabilities` returned the required tools; `/p3stack doctor` is a Pi slash command and was not run. Routing eval skipped because routes and chains did not change.

## Follow-up

None.
