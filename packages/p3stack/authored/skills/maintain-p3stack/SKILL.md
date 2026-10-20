---
name: maintain-p3stack
description: Audit p3stack's current source pins or bump its vendored upstream skills, repair generator rules, and open maintenance PRs. Use for p3stack maintenance, upstream refreshes, and scheduled pin checks.
---

# Maintain p3stack

Audit the current pins first. Select audit-only or bump mode from the operator's request before running commands. A supplied ref or any explicit bump request selects bump mode. Use this exact request sentence for a ref update. Replace the placeholders with the source and ref.

`Bump <source> to <ref> and open its maintenance PR.`

An explicit bump request authorizes every scoped input repair named in the failure classes, including registry rows, token rules, patches, and pin inputs, without another question, and requires an approval pause only before `gh pr create` if the request says to pause.

For all upstream tips, use `Bump every vendored source to its upstream tip and open a maintenance PR for each checkout.`. In bump mode, a successful audit continues to the bump procedure. The audit-only stop does not apply. The [nightly prompt](references/nightly.md) uses that exact upstream-tip request.

Work in the repository that contains this package. Read its `AGENTS.md` and `packages/p3stack/AGENTS.md`. Run every command below from the repository root. Package commands use `npm --prefix packages/p3stack` or an explicit package path. Keep a Markdown checklist and receipt paths outside the checkout.

Change inputs in `registry/`, `rules/`, `overlays/`, `patches/`, `extra/`, or `authored/`. Generate `skills/` and `agents/`. Never hand-edit generated output or files under `vendor/`. Move vendor pins only through the bump command. Repair vendored text through generator inputs. Never remove, narrow, or disable deny tokens in `rules/lint.json` to pass a bump. Translate the offending sentence with a token rule or record a registry drop with a reason. Never merge. Never write under `~/.pi/agent`, run `pi install` or `mise install`, or update T3. Use the installed tools and disposable fixture settings.

## Audit the current pins

1. Run each precondition command below separately. Require exit code 0 and the literal pass condition for each command. Stop at the first failure without changing the tree. Record the failing output and ask the owner to preserve local changes separately.

   - `git status --porcelain=v1 --untracked-files=all` must print nothing.
   - Run `node -e 'const {execFileSync}=require("node:child_process"); const s=execFileSync("git",["submodule","status","--recursive"],{encoding:"utf8"}); process.stdout.write(s); if(s.split("\n").filter(Boolean).some(l=>!l.startsWith(" "))) process.exit(1); console.log("Submodule pins match staged gitlinks.")'`. This executes `git submodule status --recursive` and requires a literal space at the start of every status line. A leading `-`, `+`, or `U` fails. Require exit code 0 and the exact final line `Submodule pins match staged gitlinks.`. That result passes the pin precondition. Do not reinterpret branch labels or invent a mismatch.
   - Enumerate the unique checkout paths with `node -e 'const m=require("./packages/p3stack/rules/manifest.json"); console.log([...new Set(m.sources.map(s=>s.upstream.checkout))].join("\n"))'`. Require exit code 0 and one checkout path per line. For each printed `<checkout>`, run `git -C packages/p3stack/<checkout> status --porcelain=v1 --untracked-files=all`. Each status command must print nothing.
2. Read `rules/manifest.json` and `registry/skills.json`. List every vendored source, its checkout, and its current full SHA. Group sources that share a checkout. Audit the authored `source: "p3stack"` rows through the registry, not an upstream command.
3. From the repository root, run `./scripts/check.sh` on the current pins. Save its complete output to a receipt outside the checkout. Require exit code 0 and the exact final line `Root check passed.`. Stop on failure. Use [failure classes](references/failure-classes.md) to identify the input owner. A T3 pin failure goes through the separate host-contract procedure below, not an upstream bump.
4. From the repository root, run `node packages/p3stack/generator/generate.mjs --check`, `node packages/p3stack/generator/check-registry.mjs`, and `node packages/p3stack/generator/check-t3-pin.mjs`. Require exit code 0 from all three commands. The generator output must start with `Generated output is current.`. The registry result must end with `0 unclassified`. The T3 result must say `matches rules/t3-pin.json` or explicitly report `Skipping T3 pin check because ~/.t3 is absent.`. The generator check verifies every source checkout against its staged gitlink and the README pins. Use its diagnostics, not a manual SHA judgment. Do not pass `--check` to the bump command.
5. Run the loader and fresh-process smoke below. Check the root and checkout status again. For each vendored source, print `<source> <sha> clean` only if its pins, generated output, and checkout status agree. Report the authored registry result separately. A skipped T3 check is a skip, not a match.
6. Only in audit-only mode, end here with the per-source status and receipt paths. Create no branch, bump note, commit, or PR. This audit does not claim that remote upstream has no newer commits. Audit-only mode runs no routing eval, no bump, and no generation, with routing eval reserved for the bump path only.

## Bump the requested upstream sources

1. Start from the successful audit. Read Opening a PR at the exact repository-root path `packages/p3stack/skills/poteto-mode/playbooks/opening-a-pr.md` to resolve the PR forge. Do not guess a relative path. Check existing maintenance PRs before creating another. Use an isolated worktree and your own branch for each independent checkout. Start each worktree at the audited base, not another source's changes.
2. Run `npm --prefix packages/p3stack run bump -- <source>` for each requested source in manifest order. If the operator supplied a ref, pass that ref as the final argument. Save the exit code, scope report, and old and new full SHAs even when generation fails. Stop on fetch or ref errors. A generation failure leaves the checkout at the candidate pin for repair. Repair the named generator input and regenerate. Do not replace a failed bump with a manual vendor checkout.
3. Immediately after the bump moves a candidate pin, stage its gitlink before any pin check, even if generation failed. For `cursor-plugins` or `owner-plugins`, run `git add packages/p3stack/vendor/pstack`. For `matt-pocock`, run `git add packages/p3stack/vendor/matt-pocock`. For another checkout, run `git add packages/p3stack/<checkout>` with its manifest checkout path. Before this step, `checkout pin ... differs from gitlink ...` is expected candidate drift, not a blocker. After staging, run the pin check only after repairing generation failures.

   Review every source scope that shares the changed checkout. At present, `cursor-plugins` and `owner-plugins` share `vendor/pstack`. Run the bump for each shared source at the same candidate SHA. Run `git -C packages/p3stack/<checkout> diff --name-status <old> <new> -- <source subtree>` for each source, since the second bump can report no movement. Use one PR per checkout, not per source. Keep the shared gitlink in one PR that names both sources. An independent source has its own checkout and PR.
4. Read the scope report, including every `review scope` path. Read the upstream commits with `git -C packages/p3stack/<checkout> log --oneline <old>..<new>` and `git -C packages/p3stack/<checkout> show --stat <sha>`. Inspect the relevant full diffs, including packaging outside the mapped subtree. Write a decision list for each new, renamed, removed, or behavior-changing skill.
5. Classify every new upstream skill explicitly in `packages/p3stack/registry/skills.json`. For each `Unclassified skill <source>/<path>`, add a row with that exact `source` and `path`, `action` of `emit` or `drop`, and a concrete `reason`. An emit row also needs `name`, `invocation`, `phases`, and `roles`. Use the [row templates](references/failure-classes.md). Do the edit, not just a recommendation. This step is incomplete until every reported path has its row and `node packages/p3stack/generator/check-registry.mjs` reports `0 unclassified`.

   Run `npm --prefix packages/p3stack run generate`. For each failure, read [failure classes](references/failure-classes.md) and repair the named input. Keep a reason for every registry drop. Repeat until generation passes. Review section changes before accepting a new hash. Record rule ids, changed matches, section diffs, and route decisions for the bump note.
6. Review `git diff -- packages/p3stack/skills packages/p3stack/agents` against the decision list. Account for every semantic change. Save the intended diff, regenerate, and compare the new diff with that snapshot. The difference between the two generations must be empty, not the intended bump diff.
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

      A per-file patch in `packages/p3stack/patches/` against the post-rule referencing skill is the alternative. Never edit `vendor/` or generated `skills/`. Regenerate with `npm --prefix packages/p3stack run generate` and rerun `npm --prefix packages/p3stack run check` until it exits 0.

7. If routes or chains changed, execute `npm --prefix packages/p3stack run eval:routing` as its own tool call. Require every case to pass and save the stream. Run it even if another validation step fails. Do not chain the eval behind checks or tests.
8. Confirm that step 3 staged the intended gitlink. Stage the intended maintenance changes before the pin check, because `--check` compares the staged gitlink. Run `npm --prefix packages/p3stack run check`, `npm --prefix packages/p3stack test`, `node packages/p3stack/generator/check-registry.mjs`, and `node packages/p3stack/generator/check-t3-pin.mjs`. Require exit code 0 from each command. Run the loader check below. Run `./scripts/check.sh` and require exit code 0 with the exact final line `Root check passed.`. Keep all receipts.
9. If lockfiles are stale, stop this source update and dispatch a separate dependency refresh using the root's `docs/dependency-refresh-2026-10-18.md`. That procedure includes tool updates and merge steps outside this skill's authority. Report the handoff instead of executing those steps here.
10. If the full source update leaves no tracked or untracked changes, print the per-source clean statuses and open no PR. Otherwise write one package-local `docs/bumps/<YYYY-MM-DD>-<source>.md` per affected source using [the bump-note format](references/bump-note.md). For a shared checkout, both notes link the same PR. Follow Opening a PR to commit, push only your branch with hooks, and open a ready PR with the notes and receipts. In the body, name each newly classified source-relative path and its emit or drop verdict. For a min-match repair, fill the literal block in the bump-note format with the rule id, old `find`, new `find`, and unchanged `min`. Before `gh pr create`, grep the body file with `grep -F` for the rule id and both literal `find` strings. Require all three greps to exit 0. If any is missing, fix the body first. For a section-hash repair, include the actual upstream section diff in the PR body using the block in the bump-note format. A receipt link alone does not satisfy this requirement. Never merge or arm auto-merge.
11. End with the fresh-process smoke below. Report the source statuses, candidate pins, PR links, and any blocked source. A failed check is blocked, not clean.

## Check the loader and smoke

Read `PI_CODING_AGENT_DIR` from the environment. If it names an existing disposable directory outside the checkout and outside `~/.pi/agent`, reuse it. Otherwise create a fixture directory outside both locations. Copy only the required credential files into a new fixture without printing their contents. Its `settings.json` must list this checkout's `packages/p3stack` as a local package. Pass the maintenance session's selected provider, model, and thinking level explicitly to the smoke with `--model <session-provider/model:thinking>`. Do not rely on fixture defaults. That model is already selected for this run, so no separate model approval is needed. If no usable model or credentials exist, report the smoke as blocked. Keep the caller's real agent settings unchanged.

Run `PI_CODING_AGENT_DIR=<fixture> pi list`. Require the local p3stack entry. Start a fresh `PI_CODING_AGENT_DIR=<fixture> pi --mode json --no-session --model <session-provider/model:thinking> -p "Reply exactly p3stack smoke ok. Do not call tools."`. Inspect the JSONL for the reply and for loader diagnostics. Require no missing resources, extension failures, or skill collisions. Preserve the stream and recheck git status. These commands load the local package without an installation.

## Repair a T3 host-contract drift

Keep this separate from source bumps. Run `node packages/p3stack/generator/check-t3-pin.mjs`. If it fails, stop the audit and report its complete output. Do not update T3 to fit the pin. Continue only under an explicit host-contract repair request. That request authorizes either repair branch below. The checker output selects the branch. Do not demand a narrower request that says version-only repair.

1. Run the pin checker again as its own command. Read its complete output before choosing a branch.
   - If exit code 1 includes `activeVersion is <observed>, expected <pinned>` and has no bridge-hash, tool, doctor, unreadable-input, or other failure diagnostic, the bridge hash matches. A `state read from <path>` line is path metadata, not a failure diagnostic. Do not require exactly one output line. Change only the `version` in `packages/p3stack/rules/t3-pin.json` and the pinned version line in `packages/p3stack/extra/skills/poteto-mode/references/host-capabilities.md`. If that map has no version line, append a sentence that states the pinned T3 version. Keep the hash, direct tools, and contract text unchanged. Do not edit tests, checker logic, or any other input as a version-only repair. Report an old-version test failure to the pin checker's owner rather than widening this PR. No doctor dump or live T3 thread is required for this version-only repair.
   - If any line starts with `bridge SHA-256 is`, stop before editing either pin input. Report that a live T3 thread must capture `/p3stack doctor` with a disposable agent directory. Native Pi's empty tool catalog cannot prove the T3 contract. In that T3 thread, compare the installed bridge and direct tools with the [host map](../poteto-mode/references/host-capabilities.md), then run `node packages/p3stack/generator/check-t3-pin.mjs --doctor <dump>`. Check where the dump is written before invoking doctor. Resume a hash repair only after reviewing the actual contract differences.
   - For unreadable JSON or any other diagnostic, use [failure classes](references/failure-classes.md). Do not treat it as version-only drift.
2. Run `npm --prefix packages/p3stack run generate` to derive the host map. Run `node packages/p3stack/generator/check-t3-pin.mjs`, `node packages/p3stack/generator/lint-hosts.mjs`, `npm --prefix packages/p3stack run check`, and `npm --prefix packages/p3stack test`. Require exit code 0 from each command. Run `./scripts/check.sh` and require exit code 0 with the exact final line `Root check passed.`.
3. Review `git diff --name-only`. For a version-only repair, require exactly `packages/p3stack/rules/t3-pin.json`, `packages/p3stack/extra/skills/poteto-mode/references/host-capabilities.md`, and `packages/p3stack/skills/poteto-mode/references/host-capabilities.md`. Write receipts outside the checkout. Create no source bump note. Read `packages/p3stack/skills/poteto-mode/playbooks/opening-a-pr.md`. Follow it for a separate host-contract PR with those receipts, no vendor, route, or dependency changes, and no merge. End with the loader and fresh-process smoke above.

## Finish

Not done while `npm run check` reports `references/missing`.

An audit-only run is done when every source has a status, the authored registry result is reported, both loader checks pass, and status is empty. It creates no PR.

An unchanged bump is done when the candidate pins have been checked, each source has its clean status, and the tree is empty. It creates no PR. A changed bump or host repair is done only with the PR URL returned by `gh pr create`, or a `BLOCKED` report that quotes the exact failing command, its exit code, and its output. Preserve the candidate and receipts on a block. An audit-only reply to an explicit bump request, an acknowledged but unclassified path, or a promise to continue is not a completed run.
