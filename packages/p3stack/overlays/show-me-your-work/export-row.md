## Export a row

Use `scripts/log.sh <logfile> <ts> <phase> <decision> <why> <evidence> <result>` to write selected ledger rows to a fresh export. Copy `ts` from the row and use its `unit` for `phase`. The helper writes the header on first use, strips stray tabs and newlines, and quotes cells that might be spreadsheet formulas. Keep the reviewed commit and a retrievable evidence pointer with each claim.
