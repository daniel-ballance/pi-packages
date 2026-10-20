### 2. Load current state

The default role-to-model mapping is the file shape shown in step 5 below. If `.pi/p3stack.json` (trusted project) or `~/.pi/agent/p3stack.json` already exists, read it and treat its `budget` and its role values as the current choices. Otherwise start from those defaults. A role not in step 5, such as `how critics`, is retired. Drop it.
