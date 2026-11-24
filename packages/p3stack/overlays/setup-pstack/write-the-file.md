### 5. Write the file

Write `p3stack.json` in Pi's agent directory (step 2), or `.pi/p3stack.json` for a trusted project-only choice. Ask before replacing an existing file. Without confirmation, leave it unchanged. Record the budget and exact selections:

- Terminal: `<provider>/<model id>:<thinking>`.
- T3: `<provider instance>/<model id>:<thinking>`. Keep the whole model id, including any slashes. For instance `pi` offering model `xai/grok-4.7` at `xhigh`, write `pi/xai/grok-4.7:xhigh`.

Example terminal file:

```json
{
  "budget": "large (xhigh)",
  "roles": {
    "feature, refactoring": "xai/grok-4.7:xhigh",
    "bug-fix": "xai/grok-4.7:xhigh",
    "perf-issue": "xai/grok-4.7:xhigh",
    "hillclimb": "xai/grok-4.7:xhigh",
    "judgment and prose": "claude/claude-opus-5-5:xhigh",
    "hardest tasks": "claude/claude-opus-5-5:xhigh",
    "how explorer": "xai/grok-4.7:xhigh",
    "how explainer": "claude/claude-opus-5-5:xhigh",
    "why investigators": "xai/grok-4.7:xhigh",
    "why synthesizer": "claude/claude-opus-5-5:xhigh",
    "reflect tooling": "xai/grok-4.7:xhigh",
    "reflect judgment, divergent, synthesizer": "claude/claude-opus-5-5:xhigh",
    "arena runners": ["claude/claude-opus-5-5:xhigh", "xai/grok-4.7:xhigh"],
    "arena cross-judge pool": ["claude/claude-opus-5-5:xhigh", "xai/grok-4.7:xhigh"],
    "swarm workers": "xai/grok-4.7:xhigh",
    "architect runners": ["claude/claude-opus-5-5:xhigh", "xai/grok-4.7:xhigh"],
    "interrogate reviewers": ["claude/claude-opus-5-5:xhigh", "xai/grok-4.7:xhigh"]
  }
}
```

Report the destination, budget and role selections actually written, including any lower judgment level. Use the providers step 1 detected. Delete a role to fall back to the skill default. `inherit-parent` or `auto` as a value runs the role on the parent chat's model. Alias entries in a panel list still count toward its fan-out.
