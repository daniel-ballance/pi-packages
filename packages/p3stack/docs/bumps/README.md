# Upstream bump notes

Source update PRs include `<YYYY-MM-DD>-<source>.md` in this directory. The date is the run date. The source is a name from `rules/manifest.json`.

The [bump-note format](../../authored/skills/maintain-p3stack/references/bump-note.md) defines the required headings, pins, decisions, and verification receipts. A clean audit or unchanged bump creates no note. Sources that share a checkout have separate notes that link the same PR.

Run `/skill:maintain-p3stack` to audit current pins. Request an upstream-tip bump explicitly to prepare source update PRs. The procedure never merges them.
