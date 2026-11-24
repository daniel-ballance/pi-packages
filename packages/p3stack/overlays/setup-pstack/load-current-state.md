### 2. Load current state

The default role-to-model mapping is the file shape shown in step 5 below. Use the first valid role file: `.pi/p3stack.json` in a trusted project, then `p3stack.json` in Pi's agent directory (`PI_CODING_AGENT_DIR` when nonempty, otherwise `~/.pi/agent`; expand a leading `~`). Report any malformed file you skip. Use that file's budget and roles, with skill defaults for missing roles. With no valid file, use the defaults. A role not in step 5, such as `how critics`, is retired. Drop it.
