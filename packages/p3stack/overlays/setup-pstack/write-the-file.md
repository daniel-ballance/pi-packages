### 5. Write the file

Write `p3stack.json` in Pi's agent directory (step 2), or `.pi/p3stack.json` for a trusted project-only choice. Ask before replacing an existing file. Without confirmation, leave it unchanged. Set `host` to `terminal` or `t3` for the host writing the file. Use the confirmed catalog identities, including the thinking level:

- Terminal: `<provider>/<model id>:<thinking>`.
- T3: `<provider instance>/<model id>:<thinking>`. Keep the whole model id, including any slashes.

Example shape for two terminal selections (not model defaults):

```json
{{role-example}}
```

Omit a role to use its skill default.
