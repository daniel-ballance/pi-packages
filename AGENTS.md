# Repository guidance

- Use [`README.md`](README.md) for the clean-clone, runtime, and CI contract.
- Run the canonical root check with `./scripts/check.sh` (`npm run check` is its wrapper); CI installation is defined by [`scripts/ci-install.sh`](scripts/ci-install.sh) and [`.github/workflows/ci.yml`](.github/workflows/ci.yml). Package scripts remain the source of truth for package checks.
- Before changing generated agent skills, read [`packages/agent-skills/AGENTS.md`](packages/agent-skills/AGENTS.md). Its generated-file contract and translation source are [`packages/agent-skills/scripts/sync.sh`](packages/agent-skills/scripts/sync.sh); the upstream source is the initialized `vendor/matt-pocock` submodule.
- Launch Pi from the repository root when project settings or policy should apply; nested package working directories do not walk up to discover root project configuration.
