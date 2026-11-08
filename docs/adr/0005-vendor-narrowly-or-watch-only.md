# Vendor narrowly, or watch only

We added two upstreams in different ways. `addyosmani/agent-skills` is vendored with four of its 25 skills emitted (`constraints`, `source-grounding`, `security-hardening`, `instrumentation`): its skills are mostly self-contained, harness-neutral by policy, and fill gaps no other source covers. `obra/superpowers` is vendored **watch only**: it ships its license and nothing else, and each of its skills is a drop that names the p3stack file restating its idea. Its skills are densely cross-referenced, script-backed, and built around an always-on bootstrap that would compete with the router, so its value to p3stack is a handful of ideas (the run ledger, the brief contract, the review stance), not its files.

`rules/borrowed.json` lists every upstream path whose idea p3stack restates, with the files that restate it. A bump's scope report marks a changed borrowed path, and `maintain-p3stack` reviews it, so a borrowed idea cannot drift from its source unnoticed.

## Considered options

- **Vendor superpowers with a few emits**: rejected. Nearly every row would be a drop, the emitted skills would pull in `superpowers:` cross-references and scripts, and its TDD and debugging skills duplicate stronger ones already shipped.
- **No superpowers source, credit in comments only**: rejected. Nothing would notice when the ideas we borrowed change upstream.
- **Vendor agent-skills whole**: rejected. Its router, personas, and most lifecycle skills duplicate p3stack's or are general reference material that costs context without changing behavior.

## Consequences

Two more submodules and licenses ship with the package. The registry classifies every upstream skill of both sources. Each new source has its own checkout and its own maintenance PR.
