# Bump-note format

Write the note at `packages/p3stack/docs/bumps/<YYYY-MM-DD>-<source>.md`. Use the run date and the manifest source name. Write no note for a clean audit or an unchanged bump. For a shared checkout, write a note for each affected source and link the same PR.

Use these headings and replace the placeholders with observed facts. Mark a check as skipped with its reason instead of claiming a pass.

```markdown
# <Source> bump on <YYYY-MM-DD>

## Pins

- Source and upstream repository.
- Checkout path and shared sources, if any.
- Old full SHA and new full SHA.
- Upstream comparison link and maintenance PR link.

## Upstream scope

List upstream commits and changed mapped paths. Account for every path marked review scope, including packaging outside the source subtree.

## Decisions

List new, renamed, and removed skills with registry verdicts and reasons. Name each repaired rule id and its old and new match. Include each changed section's diff and reviewed hash. Record route and chain decisions. State when none changed.

## Generated changes

Match each semantic skills or agents change to a decision above. Link the identical-diff receipt from the second generation.

## Verification

Link receipts with commands and outcomes for the current-pins root gate, generation check, registry check, package check, tests, loader, T3 pin check, final root gate, and fresh-process smoke. Include the routing eval if routes or chains changed. Record skips and blockers.

## Follow-up

Name dependency-refresh or host-contract work kept separate. Record anything blocked and why. State that the PR remains unmerged.
```
