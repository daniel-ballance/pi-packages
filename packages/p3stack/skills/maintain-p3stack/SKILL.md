---
name: maintain-p3stack
description: Audit p3stack's current source pins, bump its vendored upstream skills, repair generator rules, and land verified maintenance PRs. Use for p3stack maintenance, upstream refreshes, scheduled pin checks, and reverting a landed update.
---

# Maintain p3stack

Audit the current pins first. Select audit-only, bump, or revert mode from the operator's request before running commands. A supplied ref or any explicit bump request selects bump mode. Use this exact request sentence for a ref update. Replace the placeholders with the source and ref.

`Bump <source> to <ref> and land its maintenance PR.`

For all upstream tips, use `Bump every vendored source to its upstream tip and land a maintenance PR for each checkout.`. In bump mode, a successful audit continues to the bump procedure. The audit-only stop does not apply. The [nightly prompt](references/nightly.md) uses that exact upstream-tip request. `Revert p3stack maintenance PR <number>.` selects revert mode, which runs **Revert a landed update** without an audit.

**Land** means open the PR, admin squash-merge it once every gate passes, verify `main` at the merge commit from a fresh checkout, and revert the merge when that check fails. Every changed bump and every host-contract repair ends landed. A green candidate lands without waiting for review, because a revert undoes a bad landing in one commit. An open PR is a finished result only when the request says to pause before the merge.

An explicit bump request authorizes, without another question, every scoped input repair named in the failure classes, including registry rows, token rules, patches, and pin inputs. It also authorizes the admin merge, closing the maintenance PRs it supersedes, and the revert of its own merge. It pauses before the merge only if the request says to pause.

Work in the repository that contains this package. Read its `AGENTS.md` and `packages/p3stack/AGENTS.md`. Run every command below from the repository root. Package commands use `npm --prefix packages/p3stack` or an explicit package path. Keep a Markdown checklist and receipt paths outside the checkout.

Change inputs in `registry/`, `rules/`, `overlays/`, `patches/`, `extra/`, or `authored/`. Generate `skills/` and `agents/`. Never hand-edit generated output or files under `vendor/`. Move vendor pins only through the bump command. Repair vendored text through generator inputs. Never remove, narrow, or disable deny tokens in `rules/lint.json` to pass a bump. Translate the offending sentence with a token rule or record a registry drop with a reason. Never write under `~/.pi/agent`, run `pi install` or `mise install`, or update T3. Use the installed tools and disposable fixture settings.

## Audit the current pins

1. Run each precondition command below separately. Require exit code 0 and the literal pass condition for each command. Stop at the first failure without changing the tree. Record the failing output and ask the owner to preserve local changes separately.

   - `git status --porcelain=v1 --untracked-files=all` must print nothing.
   - Run `node -e 'const {execFileSync}=require("node:child_process"); const s=execFileSync("git",["submodule","status","--recursive"],{encoding:"utf8"}); process.stdout.write(s); if(s.split("\n").filter(Boolean).some(l=>!l.startsWith(" "))) process.exit(1); console.log("Submodule pins match staged gitlinks.")'`. This executes `git submodule status --recursive` and requires a literal space at the start of every status line. A leading `-`, `+`, or `U` fails. Require exit code 0 and the exact final line `Submodule pins match staged gitlinks.`. That result passes the pin precondition. Do not reinterpret branch labels or invent a mismatch.
   - Enumerate the unique checkout paths with `node -e 'const m=require("./packages/p3stack/rules/manifest.json"); console.log([...new Set(m.sources.map(s=>s.upstream.checkout))].join("\n"))'`. Require exit code 0 and one checkout path per line. For each printed `<checkout>`, run `git -C packages/p3stack/<checkout> status --porcelain=v1 --untracked-files=all`. Each status command must print nothing.
2. Read `rules/manifest.json` and `registry/skills.json`. List every vendored source, its checkout, and its current full SHA. Group sources that share a checkout. Audit the authored `source: "p3stack"` rows through the registry, not an upstream command.
3. From the repository root, run `./scripts/check.sh` on the current pins. Save its complete output to a receipt outside the checkout. Require exit code 0 and the exact final line `Root check passed.`. Stop on failure. Use [failure classes](references/failure-classes.md) to identify the input owner. A T3 contract failure goes through the separate host-contract procedure below, not an upstream bump.
4. From the repository root, run `node packages/p3stack/generator/generate.mjs --check`, `node packages/p3stack/generator/check-registry.mjs`, and `node packages/p3stack/generator/check-t3-pin.mjs`. Require exit code 0 from all three commands. The generator output must start with `Generated output is current.`. The registry result must end with `0 unclassified`. The T3 result must be `T3 static contract matches rules/t3-pin.json and the host map.`. This check reads repository inputs only. The generator check verifies every source checkout against its staged gitlink and the README pins. Use its diagnostics, not a manual SHA judgment. Do not pass `--check` to the bump command.
5. Under T3, verify the live host through **Verify host compatibility** in the [host map](../poteto-mode/references/host-capabilities.md). Require the capability-based doctor check and review the live catalog and behavior before moving vendor pins. Static success alone does not certify an installed host. Run the loader and fresh-process smoke below. Check the root and checkout status again. For each vendored source, print `<source> <sha> clean` only if its pins, generated output, and checkout status agree. Report the authored registry result separately.
6. Only in audit-only mode, end here with the per-source status and receipt paths. Create no branch, bump note, commit, or PR. This audit does not claim that remote upstream has no newer commits. Audit-only mode runs no routing eval, no bump, and no generation, with routing eval reserved for the bump path only.

## Bump the requested upstream sources

1. Start from the successful audit. Read Opening a PR at the exact repository-root path `packages/p3stack/skills/poteto-mode/playbooks/opening-a-pr.md` to resolve the PR forge. Do not guess a relative path. Process checkouts one at a time in manifest order. Start each checkout in its own isolated worktree on a new branch from the current `origin/main`, which already holds the previous checkout's landed PR. Name the branch `chore/p3stack-cursor-tip-<run-id>` for `vendor/pstack`, `chore/p3stack-pocock-tip-<run-id>` for `vendor/matt-pocock`, and `chore/p3stack-<checkout basename>-tip-<run-id>` for another checkout.

   Run `gh pr list --state open --json number,headRefName,title` and record every open PR whose head starts with this checkout's `chore/p3stack-<name>-tip-` prefix. This run bumps from current `main` to a newer tip, so it supersedes them. Close them only after this run's PR lands. Leave every other open PR untouched.
2. For an upstream-tip run, read the candidate with `git ls-remote https://github.com/<repository> refs/heads/<branch>` from the manifest's `upstream` block. Run `gh pr list --state merged --search 'revert(p3stack) in:title' --json number,title --limit 30`. If a revert title names the candidate's 7-character SHA, report that checkout `BLOCKED` with the revert PR number and move to the next checkout. A landing that already failed at this SHA needs an owner fix, not a nightly retry. An operator-supplied ref skips this guard.
3. Run `npm --prefix packages/p3stack run bump -- <source>` for each requested source of the checkout in manifest order. If the operator supplied a ref, pass that ref as the final argument. Save the exit code, scope report, and old and new full SHAs even when generation fails. Stop on fetch or ref errors. A generation failure leaves the checkout at the candidate pin for repair. Repair the named generator input and regenerate. Do not replace a failed bump with a manual vendor checkout.
4. Immediately after the bump moves a candidate pin, stage its gitlink before any pin check, even if generation failed. For `cursor-plugins` or `owner-plugins`, run `git add packages/p3stack/vendor/pstack`. For `matt-pocock`, run `git add packages/p3stack/vendor/matt-pocock`. For another checkout, run `git add packages/p3stack/<checkout>` with its manifest checkout path. Before this step, `checkout pin ... differs from gitlink ...` is expected candidate drift, not a blocker. After staging, run the pin check only after repairing generation failures.

   Review every source scope that shares the changed checkout. At present, `cursor-plugins` and `owner-plugins` share `vendor/pstack`. Run the bump for each shared source at the same candidate SHA. Run `git -C packages/p3stack/<checkout> diff --name-status <old> <new> -- <source subtree>` for each source, since the second bump can report no movement. Use one PR per checkout, not per source. Keep the shared gitlink in one PR that names both sources. An independent source has its own checkout and PR.
5. Read the scope report, including every `review scope` path. Read the upstream commits with `git -C packages/p3stack/<checkout> log --oneline <old>..<new>` and `git -C packages/p3stack/<checkout> show --stat <sha>`. Inspect the relevant full diffs, including packaging outside the mapped subtree. Write a decision list for each new, renamed, removed, or behavior-changing skill.
6. Classify every new upstream skill explicitly in `packages/p3stack/registry/skills.json`. For each `Unclassified skill <source>/<path>`, add a row with that exact `source` and `path`, `action` of `emit` or `drop`, and a concrete `reason`. An emit row also needs `name`, `invocation`, `phases`, and `roles`. Use the [row templates](references/failure-classes.md). Do the edit, not just a recommendation. This step is incomplete until every reported path has its row and `node packages/p3stack/generator/check-registry.mjs` reports `0 unclassified`.

   Run `npm --prefix packages/p3stack run generate`. For each failure, read [failure classes](references/failure-classes.md) and repair the named input. Keep a reason for every registry drop. Repeat until generation passes. Review section changes before accepting a new hash. Record rule ids, changed matches, section diffs, and route decisions for the bump note.
7. Review `git diff -- packages/p3stack/skills packages/p3stack/agents` against the decision list. Account for every semantic change. Save the intended diff, regenerate, and compare the new diff with that snapshot. The difference between the two generations must be empty, not the intended bump diff.
   1. After a re-route and regeneration, run `npm --prefix packages/p3stack run check`. A `references/missing` error is a required repair, not a stop. Add a scoped entry in `packages/p3stack/rules/tokens.json` on the referencing skill before the global slash-command rule. For example, when `sharpen` was deleted, replace the help row's link and description with a surviving `architect` target. Adapt this example to the actual upstream row.

      ```json
      {
        "id": "help-deleted-sharpen",
        "source": "cursor-plugins",
        "files": "^skills/poteto-help/SKILL\\.md$",
        "min": 1,
        "find": "\\| Get a prompt rewritten deeper[^\\n]*\\|[^\\n]*\\.\\./sharpen/SKILL\\.md\\)[^\\n]*\\|",
        "replace": "| Design a subsystem before implementation | [`/architect`](../architect/SKILL.md) |"
      }
      ```

      When removing or re-routing a target, update `packages/p3stack/test/routing-eval/prompts.json`, any fixture or assertion naming it in `packages/p3stack/test/generate.test.mjs`, `packages/p3stack/test/extension.test.ts`, or another test, and the emitted-count assertion in `packages/p3stack/test/check-registry.test.mjs`.

      A per-file patch in `packages/p3stack/patches/` against the post-rule referencing skill is the alternative. Never edit `vendor/` or generated `skills/`. Regenerate with `npm --prefix packages/p3stack run generate` and rerun `npm --prefix packages/p3stack run check` until it exits 0.

8. If routes or chains changed, execute `npm --prefix packages/p3stack run eval:routing` as its own tool call. Require every case to pass and save the stream. Run it even if another validation step fails. Do not chain the eval behind checks or tests.
9. Confirm that step 4 staged the intended gitlink. Stage the intended maintenance changes before the pin check, because `--check` compares the staged gitlink. Run `npm --prefix packages/p3stack run check`, `npm --prefix packages/p3stack test`, `node packages/p3stack/generator/check-registry.mjs`, and `node packages/p3stack/generator/check-t3-pin.mjs`. Require exit code 0 from each command. Run the loader check and fresh-process smoke below against this worktree. Run `./scripts/check.sh` and require exit code 0 with the exact final line `Root check passed.`. Keep all receipts.

   A failed gate blocks this checkout. Open no PR for it. Preserve its worktree, candidate, and receipts, report it `BLOCKED`, and continue with the next checkout from current `origin/main`.
10. If lockfiles are stale, stop this source update and dispatch a separate dependency refresh using the root's `docs/dependency-refresh-2026-10-18.md`. That procedure includes tool updates and merge steps outside this skill's authority. Report the handoff instead of executing those steps here.
11. If the full source update leaves no tracked or untracked changes, print the per-source clean statuses and open no PR. Otherwise write one package-local `docs/bumps/<YYYY-MM-DD>-<source>.md` per affected source using [the bump-note format](references/bump-note.md). For a shared checkout, both notes link the same PR. Follow Opening a PR to commit, push only your branch with hooks, and open a ready PR titled `chore(p3stack): bump <sources> to <new-sha7>` with the notes and receipts. In the body, name each newly classified source-relative path and its emit or drop verdict. For a min-match repair, set `body_file=<receipt-dir>/pr-body.md` outside the checkout and write the complete PR body there. Fill the literal block in the bump-note format with the rule id, old `find`, new `find`, and unchanged `min`. Before `gh pr create --body-file "$body_file"`, grep that exact `"$body_file"` with `grep -F` for the rule id and both literal `find` strings. Require all three greps to exit 0. If any is missing, fix that file first. The PR body is this file, not the bump note. Submit it with `--body-file "$body_file"`, never an inline `--body`. For a section-hash repair, include the actual upstream section diff in the PR body using the block in the bump-note format. A receipt link alone does not satisfy this requirement.
12. Land the PR through **Land a maintenance PR** below. Then start the next checkout at step 1. Report the source statuses, landed merge commits, PR links, any reverted or blocked checkout, and the closed superseded PRs.

## Land a maintenance PR

1. If the request says to pause before the merge, report the PR URL and stop here.
2. Run `git fetch origin`. If `git merge-base --is-ancestor origin/main HEAD` fails, `main` moved under the candidate. Rebase onto `origin/main`, run `node packages/p3stack/generator/generate.mjs --check` and `./scripts/check.sh` again, and push your own branch with hooks and `--force-with-lease`. On a rebase conflict, abort the rebase, close the PR, and restart this checkout at bump step 1 from current `origin/main`.
3. Read `gh pr view <number> --json headRefOid,isDraft,state`. Require `state` `OPEN`, `isDraft` false, and `headRefOid` equal to `git rev-parse HEAD`. Run `gh pr merge <number> --admin --squash --match-head-commit <headRefOid>`. `main` carries an owner-approval ruleset and no CI. `--admin` is the owner's bypass, and this procedure is its authorized use. Read `gh pr view <number> --json state,mergeCommit` and record `mergeCommit.oid`. Require `state` `MERGED`. Then run `git push origin --delete <branch>`.
4. Verify `main` at the merge commit. From the repository root, run `git fetch origin` and `git worktree add --detach .pi/worktrees/verify-<merge-sha7> <merge-sha>`. In that worktree, run `git submodule update --init --recursive`, `./scripts/ci-install.sh`, and `./scripts/check.sh`. Every submodule must initialize; a skipped one fails the registry check with `Stale registry row`. Run the loader check and fresh-process smoke below with the fixture listing that worktree's `packages/p3stack`. The landing is green when the root check exits 0 with the final line `Root check passed.`, the loader lists the package, and the smoke passes.
5. Green: remove the verify worktree with `git worktree remove --force <path>`, which a checkout with submodules requires. Close each superseded PR recorded in bump step 1 with `gh pr close <old> --delete-branch --comment "Superseded by #<number>, which landed <checkout> at <new-sha7>."`.
6. Red: preserve the verify worktree and its receipts, then run **Revert a landed update** for this PR. Leave the superseded PRs open.

## Revert a landed update

Run this after a red post-merge check, or when the operator asks to revert a maintenance PR.

1. Read `gh pr view <number> --json state,title,mergeCommit`. Require `state` `MERGED` and record the merge commit.
2. From current `origin/main`, create an isolated worktree on branch `revert/p3stack-<number>`. Run `git revert --no-edit <merge-sha>`, then `git submodule update --init --recursive` so each checkout matches the reverted gitlink. A conflict means later commits touched the same files. Abort the revert and report `BLOCKED` with the conflicting paths.
3. Run `./scripts/check.sh` and require `Root check passed.`. If it fails, report `BLOCKED` with the original failure and this one. `main` was red before the landing, or the revert does not restore it, and the owner decides.
4. Push your branch with hooks. Open a ready PR titled `revert(p3stack): <original subject>`. Its body states the failing command, its exit code, the relevant output, the original PR link, and the receipt path. Land it through steps 2 to 5 of **Land a maintenance PR**, with no superseded PRs to close. A red check after the revert is `BLOCKED`, not another revert.
5. Comment on the original PR with the revert PR link and the failure summary. Report the original PR `REVERTED`.

## Check the loader and smoke

Read `PI_CODING_AGENT_DIR` from the environment. If it names an existing disposable directory outside the checkout and outside `~/.pi/agent`, reuse it. Otherwise create a fixture directory outside both locations. Copy only the required credential files into a new fixture without printing their contents. Its `settings.json` must list the checkout under test's `packages/p3stack` as a local package. Pass the maintenance session's selected provider, model, and thinking level explicitly to the smoke with `--model <session-provider/model:thinking>`. Do not rely on fixture defaults. That model is already selected for this run, so no separate model approval is needed. If no usable model or credentials exist, report the smoke as blocked. Keep the caller's real agent settings unchanged.

Run `PI_CODING_AGENT_DIR=<fixture> pi list`. Require the local p3stack entry. Start a fresh `PI_CODING_AGENT_DIR=<fixture> pi --mode json --no-session --model <session-provider/model:thinking> -p "Reply exactly p3stack smoke ok. Do not call tools."`. Inspect the JSONL for the reply and for loader diagnostics. The smoke passes when the final assistant text contains `p3stack smoke ok` and the stream shows no missing resources, extension failures, or skill collisions. The smoke proves loading. A trailing period or other wording variance is not a failure and never triggers a revert. Preserve the stream and recheck git status. These commands load the local package without an installation.

## Repair a T3 host-contract drift

Keep host-contract repairs separate from source bumps. The default checker validates repository inputs. Installed release and bridge hashes are diagnostic provenance, not mandatory equality checks. Use **Verify host compatibility** in the [host map](../poteto-mode/references/host-capabilities.md) for optional installed diagnostics and required live T3 evidence. A release or hash difference alone needs no repair or fingerprint refresh.

1. For a static checker failure, use [failure classes](references/failure-classes.md) to find the input owner. For a live capability or behavior failure, preserve the doctor dump, catalog evidence, exact command, exit code, and complete output. Stop source maintenance and report the incompatibility. Continue repairs only under an explicit host-contract repair request. Preserve required behavior and add hermetic fixture coverage. If that behavior cannot be preserved and verified, report `BLOCKED` rather than weakening the contract or changing the installed host.
2. Repair authored inputs and regenerate with `npm --prefix packages/p3stack run generate`. Run `node packages/p3stack/generator/check-t3-pin.mjs`, the capability-based doctor check from the host map, `node packages/p3stack/generator/lint-hosts.mjs`, `npm --prefix packages/p3stack run check`, and `npm --prefix packages/p3stack test`. Require exit code 0 from each command and verify the repaired behavior on the live host. Run `./scripts/check.sh` and require exit code 0 with the exact final line `Root check passed.`.
3. Review `git diff --name-only`. Keep vendor pins, routes, dependencies, and fingerprint refreshes out of this repair. Write receipts outside the checkout and create no source bump note. Read `packages/p3stack/skills/poteto-mode/playbooks/opening-a-pr.md`. Follow it for a separate host-contract PR with those receipts, run the loader and fresh-process smoke above, and land it through **Land a maintenance PR**.

## Finish

Not done while `npm run check` reports `references/missing`.

`npm test` in `packages/p3stack` exits 0 before `gh pr create`; after any JSON edit rerun it.

An audit-only run is done when every source has a status, the authored registry result is reported, both loader checks pass, and status is empty. It creates no PR.

An unchanged bump is done when the candidate pins have been checked, each source has its clean status, and the tree is empty. It creates no PR.

A changed bump or host repair is done for a checkout when one of these holds:

- **Landed.** The PR merged, `main` passed the post-merge check at its merge commit, and the superseded PRs are closed. Report the PR URL and merge commit.
- **Reverted.** The post-merge check failed, the revert PR landed, and `main` is green again. Report both PR URLs and the failing receipt.
- **Paused.** The request said to pause before the merge. Report the open PR URL.
- **Blocked.** Report the exact failing command, its exit code, and its output. Preserve the candidate and receipts.

An audit-only reply to an explicit bump request, an acknowledged but unclassified path, an open PR the request did not pause, or a promise to continue is not a completed run.
