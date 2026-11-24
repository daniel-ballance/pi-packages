### 2. Load current state

Call `p3stack_roles` for the active file, budget, resolved choices and problems. It uses the first valid file: `.pi/p3stack.json` in a trusted project, then `p3stack.json` in Pi's agent directory. Read that file for the user's original pins, lists and aliases. Report skipped files. With no valid file, start from the resolved skill hints.
