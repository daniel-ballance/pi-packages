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

## PR body evidence

For every newly classified skill, include the exact source-relative path and its emit or drop verdict in the PR body. For a min-match repair, include the rule id and the literal old and new `find` values. The notes retain the full decision list. These body details let the reviewer identify the repair without opening another file.

### Include a min-match repair

Copy this literal block into the PR body for each min-match repair. Replace every placeholder with the rule's verbatim value. Preserve the literal `find` strings, including regex backslashes, without JSON escaping.

````markdown
## Min-match repair

Rule id
```text
<rule-id>
```

Old find
```text
<old-find>
```

New find
```text
<new-find>
```

Unchanged min
```text
<min>
```
````

Before `gh pr create`, run `grep -F -- '<rule-id>' <body-file>`, `grep -F -- '<old-find>' <body-file>`, and `grep -F -- '<new-find>' <body-file>` with the actual values. Require exit code 0 from all three commands. If any value is missing, fix the body file and repeat the greps before creating the PR.

### Include a section-hash diff

Include this block in the PR body itself for each changed section. Replace every placeholder. Paste the full upstream section diff, not a receipt link or only the hash change. Keep the receipt link as additional evidence.

````markdown
## Upstream section review

Source is <source>. The section is <file> at <heading>.
The reviewed hash changes from <old-hash> to <new-hash>.

```diff
<actual upstream section diff between the old and candidate pins>
```

The overlay decision is <what changed or why the existing overlay still applies>.
````
