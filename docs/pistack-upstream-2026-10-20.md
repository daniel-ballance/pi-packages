# pstack 0.15.29 update validation

## Upstream scope

The update moves `cursor/plugins` from `d457567332aa6989e753ea289f30ea2bfbc80bc0`
to `88d47514b82e7c44f00f2b2a72ff6dd12158038c`, pstack 0.15.29.
[Upstream change #729](https://github.com/cursor/plugins/pull/729) restores
`sharpen` as a prompt rewrite rather than task execution.

The updater classified all eight changed canonical paths. Three are emitted:

- `skills/sharpen/SKILL.md` asks for expert methods, raw sources, and an outside check, then rewrites the prompt and leaves the user's choices open.
- `skills/poteto-help/SKILL.md` describes that behavior.
- `skills/poteto-help/references/recipes.md` passes a prompt to sharpen.

Both plugin manifests change their version to 0.15.29. The upstream README and
guide pages 02 and 10 describe the new behavior. Those files are not emitted.
The generated help's pinned guide links advance with the pin. The changed
`harness/pstack/claude-code` files are upstream-generated copies, not inputs.
The remaining commits concern the unrelated X plugin and its catalog entries.
No upstream capability or packaging input needs a new manifest mapping.

Regeneration required no token, section, overlay, or patch changes. Generated
files were not edited by hand.

## Ingestion improvement

Direct generation previously read dirty vendor files while naming their clean
HEAD commit in output links and pin metadata. An independent baseline CLI
comparison confirmed that untracked and ignored files could be published under
the clean HEAD pin. The first four failing tests were insufficient evidence for
all four cases because two also broke an unrelated fixture token rule. Their
fixtures now preserve that rule's input.

`upstreamInfo()` now checks the consumed upstream subtree before reading plugin
metadata or collecting source files. It rejects modified, staged, untracked,
ignored, and deleted inputs. It also rejects `skip-worktree` and
`assume-unchanged` flags, which can conceal changes from Git status. Its status
probe forces `core.fileMode=true` without changing Git configuration, so mode-only
changes cannot bypass it when the clone ignores executable bits. Every Git
call uses the existing sanitized environment. Both CLI modes and the exported
`generate()` pass through this boundary. Clean unpinned fixtures still need no
Git repository.

Two independent design sketches compared this guard with reading immutable Git
trees. The guard preserves one source reader and the current API. The design
judge favored subtree scope and the hidden-index check. Reading Git trees would
require another collector, binary-object parsing, and different local-edit
semantics. That is outside this refresh.

The updater retains its whole-checkout check because moving a checkout is a
different operation. Direct generation allows unrelated sibling-plugin edits.
The maintenance instructions now explain the guard and how to recover the
source delta after an updater rerun.

This is not a lock or an atomic snapshot. Generation assumes no concurrent
writer to the vendored source. Ignored files under excluded source paths also
block generation. Preserve local work before restoring the vendor checkout.

## Validation

- The pre-update generator drift check passed.
- `npm --prefix packages/pistack run update-upstream` fetched and generated the new pin successfully.
- Two subsequent generations left the entire binary Git diff unchanged. `generate.mjs --check` passed.
- The generated `sharpen` file matches upstream byte for byte except `/sharpen` becoming `/skill:sharpen`. Manual reading confirmed that help and the recipe match the new contract.
- A fresh Claude Opus 5.5 task read the generated skill and sharpened a request to create a migration-guide file and choose a deprecation policy. It returned the four framing answers and a rewritten prompt. It left the policy to the user. The requested file did not exist afterward. This is one behavioral smoke test, not a guarantee of every model response.
- Generator and updater tests passed, 40 tests. Nine dirty-input states fail before publication in normal CLI mode, `--check`, and library use. Tests check output and pin preservation, an absent or existing candidate directory, recovery, unrelated source scope, and clean committed version drift.
- `./scripts/check.sh` passed before the ingestion guard and again after the guard and documentation changes, under Node 26.12.0 and npm 12.2.0. Package checks and tests cover both CLI and simulated T3 hosts.
- `scripts/skill-report.mjs --check` passed for home, the main checkout, and the candidate worktree. The root gate's isolated loader tests exercise the candidate package and collection. No skills or invocation flags were added or removed. All eleven Pocock coverage decisions remain unchanged.

The requested Grok role failed with account-balance errors on both Pi and native
Grok transports. Claude handled the behavior check and judgment. Codex supplied
the second design. Fresh interactive CLI and T3 prompt lists were not exercised.
No live settings or collection filters changed. The owner must update their
live checkout before that installation uses the refreshed skills.

## Integration review

An independent verifier checked the original candidate with full npm and pnpm
root checks, plus the focused generator tests on Node 22.23.3. The checks passed.
It also reproduced the old CLI defect and tested real untracked and ignored
scratch inputs against the fix without publishing output changes.

That review blocked landing because Pocock update #57 had concurrently merged
and conflicted with the coverage record. This branch rebases onto that update,
keeps its `5beb35b` Pocock pin, and records both validation reports. The review
also found the `core.fileMode=false` gap now covered by the ninth refusal case.
The final rebased revision receives another root check and independent verdict
before push and merge. The direct skill smoke test reads the generated file; it
does not exercise Pi's interactive `/skill:sharpen` command expansion.

## Reproduce

From a clean, installed checkout with initialized submodules:

```sh
node packages/pistack/generator/generate.mjs --check
node --test packages/pistack/test/generate.test.mjs packages/pistack/test/update-upstream.test.mjs
node scripts/skill-report.mjs --check ~ "$PWD"
./scripts/check.sh
```

The full updater source report can be recovered with:

```sh
git -C packages/pistack/vendor/pstack diff --name-status d457567332aa6989e753ea289f30ea2bfbc80bc0 88d47514b82e7c44f00f2b2a72ff6dd12158038c -- pstack
```
