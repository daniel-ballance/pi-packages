# pistack upstream update, 2026-10-19

## Source review

The target is `cursor/plugins@d457567332aa6989e753ea289f30ea2bfbc80bc0`,
pstack 0.15.28. The previous pin is
`0b8e952052d482ee6de06deebf14d590d77b1b34`, pstack 0.15.26.

Six commits touch canonical `pstack/` in this range.

- `75fabac` removes sharpen's ban on returning a rewritten prompt.
- `0148b78` bumps pstack to 0.15.27.
- `f9be7aa` adds the optional formal-verification setup offer and updates help
  and guide text. Its Claude Code install instructions do not apply to Pi.
- `6b78e9f` makes TLA+ the default for event-order questions in any language.
  If no verifier runs on the language, the creator tests the real code with
  generated inputs rather than a hand model of the function.
- `7b353f7` adds `maintain-formal-verification-skill`. It distinguishes stale
  verification from a product bug, records covered code and a sync commit,
  checks that updated verification can still fail, and leaves product code alone.
- `d457567` bumps pstack to 0.15.28 and aligns the guide's tool-choice text.

The full range also changes Meta Ads and Zoom plugins and generated Claude Code
copies. They remain outside the manifest. Guide and README changes were reviewed
as upstream references. The existing mapping includes the new skill without a
new path list. Generated Pi commands use `/skill:`.

## Ingestion decision

The first updater run stopped on the hashes of setup's `## Steps` and help's
`## Get set up`. Only the submodule pointer changed. A trial that updated just
the hashes passed generation but lost the new setup offer behind the broad
Pi overlays. A clean generated diff alone would not expose that loss.

Two candidate designs compared an explicit end-heading field with leaf section
rules using the existing metadata. An independent cross-judge reproduced both
setup and help translation in a scratch copy and favored leaf rules. The chosen
shape adds no rule format. Setup's host-specific steps get leaf overlays.
Host-specific help sentences get scoped token rules. Upstream verification offers
then flow through the normal token pipeline. A fence-aware check rejects section
overlays that would hide child headings, even with a current hash. Help now says
the collection installs pistack. A narrow token preserves the existing
"pistack spends" wording after removal of the broad help overlay.

This keeps paragraph changes inside a translated leaf subject to hash review.
It does not prove prose equivalence. Maintainers still compare upstream intent
with each translation before accepting a changed hash.

## Manual validation

- Compared every generated change with canonical upstream. The creator,
  maintainer, and sharpen match upstream apart from Pi output paths and command
  spelling. Setup's existing steps 1 through 7 remain byte-identical. The new
  offer is upstream text. Existing playbooks, agents, helper scripts, and license
  are unchanged.
- Repeated generation preserves SHA-256 hashes for every emitted file and the
  recorded pins. `generate.mjs --check` and `git diff --check` pass. All 36
  generator, updater, and Git-environment tests pass.
- Disabled the leaf guard in a scratch copy. Both parent-overlay regressions
  failed with missing expected exceptions. The unchanged candidate passes them.
- Loaded the candidate collection and pistack package through isolated Pi 1.3.0
  resource loaders. The new maintainer skill loads with model invocation disabled.
  pistack's `tdd` wins, with no skill diagnostics. Coverage of all eleven Pocock
  skills remains unchanged. Home and worktree `skill-report --check` also pass,
  but their live settings still select the main checkout. Fresh interactive
  CLI and T3 prompt lists were not exercised.
- Followed the creator and maintainer on a disposable JavaScript dedupe fixture.
  Generated inputs cover all 364 arrays over `[0, 1, 2]` of length 0 through 5.
  Checks call the real exports. Broken ordering fails on `[1, 0]`; restoring
  source passes. A rename requires a verification-only coverage update. The old
  check still executes the moved body through a re-export, so this case validates
  stale coverage metadata, not a checker that stopped executing current code.
  A separate product bug fails unchanged verification on `[0, 1, 0]`, without
  weakening the property or editing product code. A missing-runtime case stays
  blocked and leaves its sync commit unchanged. The generated skills lint with
  zero errors and warnings. The parent reran the fixture driver and checked the
  re-export behavior independently.

The fixture and rerunnable driver remain at `/tmp/pstack-formal-smoke` on the
validation machine. No suitable verifier was installed for that JavaScript
exercise. It uses the creator's generated-input fallback. It is not an unbounded
proof. TLA+, TLC, SMT, and proof-assistant execution were not tested.

## Review and local gates

Independent Claude Opus 5.5 review found no code or translation blockers. It
required a fresh root check because the first green run preceded the final cost
translation. The fresh canonical `./scripts/check.sh` passed with the locked npm
workspace on Node 26.12.0 and npm 12.2.0. The pre-push hook runs it again against
the committed tree. Comment review found no changed comments to remove. No
dependency or lockfile changes are needed.
