---
description: Commit, push and open a pull request, then link it to this T3 thread
argument-hint: "[notes for the pull request]"
---
Ship this thread's work as a pull request. Notes from the user: ${@:-none}.

1. Run the checks the project names in AGENTS.md or README. Fix every failure before you continue.
2. If this thread is on the default branch, create a feature branch. Commit the work with messages that say why it changed.
3. Push with upstream tracking and open the pull request with `gh pr create`. Write the body with the `pr` skill when it is available, otherwise with the repository's pull request template.
4. Call `link_pull_request` with the pull request URL so T3 shows it on this thread and settles the thread when it merges.
5. Reply with the URL and the parts a reviewer should read first.
