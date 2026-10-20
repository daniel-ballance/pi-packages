---
name: maintain-p3stack
description: Audit p3stack's current source pins or bump its vendored upstream skills, repair generator rules, and open maintenance PRs. Use for p3stack maintenance, upstream refreshes, and scheduled pin checks.
---

# Maintain p3stack

Audit the current pins first. Stop after the audit unless the operator explicitly requests an upstream-tip bump or supplies a ref. The [nightly prompt](references/nightly.md) requests a bump.

Work in the repository that contains this package. Read its `AGENTS.md` and `packages/p3stack/AGENTS.md`. Run package commands from `packages/p3stack` and the root gate from the repository root. Keep a Markdown checklist and receipt paths outside the checkout.

Change inputs in `registry/`, `rules/`, `overlays/`, `patches/`, `extra/`, or `authored/`. Generate `skills/` and `agents/`. Never hand-edit generated output. Never merge. Never write under `~/.pi/agent`, run `pi install` or `mise install`, or update T3. Use the installed tools and disposable fixture settings.

## Audit the current pins

1. Run `git status --porcelain=v1 --untracked-files=all` at the root and in every checkout named by `rules/manifest.json`. If any tree is dirty, stop without changing it. Record the paths and ask the owner to preserve the changes separately.
2. Read `rules/manifest.json` and `registry/skills.json`. List every vendored source, its checkout, and its current full SHA. Group sources that share a checkout. Audit the authored `source: "p3stack"` rows through the registry, not an upstream command.
3. From the repository root, run `./scripts/check.sh` on the current pins. Save its complete output to a receipt outside the checkout. Check its exit code and final line. Stop on failure. Use [failure classes](references/failure-classes.md) to identify the input owner. A T3 pin failure goes through the separate host-contract procedure below, not an upstream bump.
4. From the repository root, run `node packages/p3stack/generator/generate.mjs --check`, `node packages/p3stack/generator/check-registry.mjs`, and `node packages/p3stack/generator/check-t3-pin.mjs`. The generator check verifies every source checkout against its staged gitlink and the README pins. Use this existing check rather than passing `--check` to the bump command.
5. Run the loader and fresh-process smoke below. Check the root and checkout status again. For each vendored source, print `<source> <sha> clean` only if its pins, generated output, and checkout status agree. Report the authored registry result separately. A skipped T3 check is a skip, not a match.
6. If no bump was requested, end here with the per-source status and receipt paths. Create no branch, bump note, commit, or PR. This audit does not claim that remote upstream has no newer commits.

## Bump the requested upstream sources

1. Start from the successful audit. Read Opening a PR at `../poteto-mode/playbooks/opening-a-pr.md` to resolve the PR forge. Check existing maintenance PRs before creating another. Use an isolated worktree and your own branch for each independent checkout. Start each worktree at the audited base, not another source's changes.
2. Run `npm run bump -- <source>` for each requested source in manifest order. If the operator supplied a ref, pass that ref as the final argument. Save the exit code, scope report, and old and new full SHAs even when generation fails. Stop on fetch or ref errors. A generation failure leaves the checkout at the candidate pin for repair.
3. Review every source scope that shares the changed checkout. At present, `cursor-plugins` and `owner-plugins` share `vendor/pstack`. Run the bump for each shared source at the same candidate SHA. Inspect `git diff --name-status <old> <new> -- <source subtree>` in the vendor checkout for each source, since the second bump can report no movement. Keep the shared gitlink in one PR that names both sources. Use one PR per source when its checkout is independent.
4. Read the scope report, including every `review scope` path. Read the upstream commits with `git -C <checkout> log --oneline <old>..<new>` and `git -C <checkout> show --stat <sha>`. Inspect the relevant full diffs, including packaging outside the mapped subtree. Write a decision list for each new, renamed, removed, or behavior-changing skill.
5. Run `npm run generate`. For each failure, read [failure classes](references/failure-classes.md) and repair the named input. Keep a reason for every registry drop. Repeat until generation passes. Review section changes before accepting a new hash. Record rule ids, changed matches, section diffs, and route decisions for the bump note.
6. Review `git diff -- skills agents` against the decision list from the package directory. Account for every semantic change. Save the intended diff, regenerate, and compare the new diff with that snapshot. The difference between the two generations must be empty, not the intended bump diff.
7. Stage only the intended vendor gitlink and maintenance changes before the pin check, because `--check` compares the staged gitlink. Run `npm run check`, `npm test`, `node generator/check-registry.mjs`, and `node generator/check-t3-pin.mjs`. Run the loader check below. If routes or chains changed, run `npm run eval:routing` and require every case to pass. Run `./scripts/check.sh` from the root. Keep all receipts.
8. If lockfiles are stale, stop this source update and dispatch a separate dependency refresh using the root's `docs/dependency-refresh-2026-10-18.md`. That procedure includes tool updates and merge steps outside this skill's authority. Report the handoff instead of executing those steps here.
9. If the full source update leaves no tracked or untracked changes, print the per-source clean statuses and open no PR. Otherwise write one package-local `docs/bumps/<YYYY-MM-DD>-<source>.md` per affected source using [the bump-note format](references/bump-note.md). For a shared checkout, both notes link the same PR. Follow Opening a PR to commit, push only your branch with hooks, and open a ready PR with the notes and receipts. Never merge or arm auto-merge.
10. End with the fresh-process smoke below. Report the source statuses, candidate pins, PR links, and any blocked source. A failed check is blocked, not clean.

## Check the loader and smoke

Use an existing disposable `PI_CODING_AGENT_DIR` or create one outside the checkout and outside `~/.pi/agent`. Copy only the required credential files into it without printing their contents. Its `settings.json` must list this checkout's `packages/p3stack` as a local package and select an available operator-approved model. Keep the caller's real agent settings unchanged.

Run `PI_CODING_AGENT_DIR=<fixture> pi list`. Require the local p3stack entry. Start a fresh `PI_CODING_AGENT_DIR=<fixture> pi --mode json --no-session -p "Reply exactly p3stack smoke ok. Do not call tools."`. Inspect the JSONL for the reply and for loader diagnostics. Require no missing resources, extension failures, or skill collisions. Preserve the stream and recheck git status. These commands load the local package without an installation.

## Repair a T3 host-contract drift

Keep this separate from source bumps. If the current host differs from `rules/t3-pin.json`, stop the audit and report the observed version and hash. Do not update T3 to fit the pin. Under an explicit host-contract repair request, compare the installed bridge and direct tools with the [host map](../poteto-mode/references/host-capabilities.md). Use `/p3stack doctor` only with a disposable agent directory, then run `node generator/check-t3-pin.mjs --doctor <dump>`. Check where that host writes the dump before running the command.

Change only `extra/skills/poteto-mode/references/host-capabilities.md` and `rules/t3-pin.json` as authored inputs. Regenerate the derived host map. Require the pin check, host lint, package tests, and root gate. Put observed contract differences and receipts in a separate PR with no vendor, route, or dependency changes.
