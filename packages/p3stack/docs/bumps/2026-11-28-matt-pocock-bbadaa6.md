# Matt Pocock skills bump on 2026-11-28

## Pins

- `matt-pocock` takes `vendor/matt-pocock` from `d65391149dbb5fe76478e76fa8d5122b2aa5a70e` to `bbadaa631c37af594e5a05c9cefacd9956136b18`.
- [Upstream comparison and commits](https://github.com/mattpocock/skills/compare/d65391149dbb5fe76478e76fa8d5122b2aa5a70e...bbadaa631c37af594e5a05c9cefacd9956136b18) and [maintenance PR for this branch](https://github.com/daniel-ballance/pi-packages/pulls?q=is%3Apr+head%3Achore%2Fp3stack-pocock-tip-20261128-bbadaa6).

## Scope and decisions

- `engineering/domain-modeling/GLOSSARY-FORMAT.md` now bolds related glossary terms inside definitions. `engineering/to-tickets/SKILL.md` asks for the parent issue title as well as its tracker reference. It still links tickets to a parent only when the source was an existing issue.
- `.changeset/glossary-bold-terms.md` and `.changeset/to-tickets-parent-title.md` record the edits upstream. Neither path maps to p3stack output.
- No borrowed source, registry row, token, section, route, or chain changes. No host operation changed.

## Generated changes

The two skill files reproduce the upstream wording changes. The README records the new pin. See the maintenance PR for the second-generation diff check.

## Verification

The [base commit](https://github.com/daniel-ballance/pi-packages/commit/0125739e1e0da1b22a508da87fba4c2966508043) passed the root check with zero unclassified skills, the live T3 doctor inventory, and both Pi smoke checks. No routing eval is needed because routes and chains did not change. See the maintenance PR for the candidate checks.
