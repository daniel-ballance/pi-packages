# Upstream bump notes

Write one note per pull request that moves a checkout. Name it `<YYYY-MM-DD>-<checkout-name>-<new-sha7>.md`. A clean audit or an unchanged checkout needs no note.

List the old and new pins once. Cover **every source** in the checkout, even if its subtree did not change. For each source, record the scope and the decisions about its skills, rules, and generated files. Record shared checks once. Mark a skipped or blocked check with the reason.

Link evidence to a commit, a pull request, or a CI run. Never use a path under `/tmp` as evidence. Existing dated notes are historical records.
