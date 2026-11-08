# Execution ledger

Conversation memory does not survive compaction. A run that delegates more than one unit of work keeps a ledger, so a controller that loses its place never redoes finished work.

**Where.** `<store>/runs/<run-id>/ledger.md`, with the store from **Store** in the poteto-mode host capabilities (`poteto-mode/references/host-capabilities.md`). Use the branch or plan name as the run id. Put the ledger's absolute path in every brief that reports into it.

**Format.** The first line names the run: `# Ledger: <plan, spec, or ticket graph>`. Then append one line per event, never edit earlier lines:

- `Unit <id>: dispatched <child> base <sha7>`
- `Unit <id>: complete <base7>..<head7>, review clean` or `, <K> parked`
- `Ruling: <what you decided> | <why> | <what it costs if wrong>` for each judgement call you made instead of asking
- `Parked: <finding> | <why it stays open>`

**Recovery.** After compaction or in a new session, read the ledger and `git log` before anything else, and trust them over your memory. The commits a ledger names exist even when you no longer remember making them.

**Close.** When the run lands, move each ruling that a future reader would need into an ADR (**domain-modeling**), then delete the run directory. The decision trail from **show-me-your-work** is the audit record and stays; the ledger is only for recovery.
