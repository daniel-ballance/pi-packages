# Repository guidance

- Use [`README.md`](README.md) for the clean-clone, runtime, and CI contract.
- Run the canonical root check with `./scripts/check.sh` (`npm run check` is its wrapper); CI installation is defined by [`scripts/ci-install.sh`](scripts/ci-install.sh) and [`.github/workflows/ci.yml`](.github/workflows/ci.yml). Package scripts remain the source of truth for package checks.
- Before changing generated agent skills, read [`packages/pi-pocock-skills/AGENTS.md`](packages/pi-pocock-skills/AGENTS.md). Its generated-file contract and translation source are [`packages/pi-pocock-skills/scripts/sync.sh`](packages/pi-pocock-skills/scripts/sync.sh); the upstream source is the initialized `vendor/matt-pocock` submodule.
- Lint skills with the repository tool [`scripts/lint-skill`](scripts/lint-skill/README.md). It belongs to no package; a package's `check` script calls it with explicit skill directories.
- Launch Pi from the repository root when project settings or policy should apply; nested package working directories do not walk up to discover root project configuration.
- A new tool or `ctx.ui` call follows the host-parity rules in [`CONTEXT.md`](CONTEXT.md) ("Host parity") and [ADR 0001](docs/adr/0001-host-parity.md): detect the host with [`shared/host.ts`](shared/host.ts), whose per-package copies [`scripts/sync-shared.mjs`](scripts/sync-shared.mjs) writes and `./scripts/check.sh` verifies; never edit a copy.
