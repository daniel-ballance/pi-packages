### 5. Write the file

Write `~/.pi/agent/pistack.json`, or `.pi/pistack.json` when the user wants a project-only choice. Record the budget label and its target thinking level, and one entry per role, using the same labels poteto-mode uses. Overwrite the whole file so re-runs stay idempotent. Models are exact identities per **Models and role defaults**: `provider/model:thinking` in a terminal, `<provider instance>/<model>:<thinking>` from the catalog under T3. Shape:

```json
{
  "budget": "large (xhigh)",
  "roles": {
    "feature, refactoring": "xai/grok-4.7:xhigh",
    "bug-fix": "xai/grok-4.7:xhigh",
    "perf-issue": "xai/grok-4.7:xhigh",
    "hillclimb": "xai/grok-4.7:xhigh",
    "judgment and prose": "claude-subscription/claude-opus-5-5:xhigh",
    "hardest tasks": "claude-subscription/claude-opus-5-5:xhigh",
    "how explorer": "xai/grok-4.7:xhigh",
    "how explainer": "claude-subscription/claude-opus-5-5:xhigh",
    "why investigators": "xai/grok-4.7:xhigh",
    "why synthesizer": "claude-subscription/claude-opus-5-5:xhigh",
    "reflect tooling": "xai/grok-4.7:xhigh",
    "reflect judgment, divergent, synthesizer": "claude-subscription/claude-opus-5-5:xhigh",
    "arena runners": ["claude-subscription/claude-opus-5-5:xhigh", "xai/grok-4.7:xhigh"],
    "arena cross-judge pool": ["claude-subscription/claude-opus-5-5:xhigh", "xai/grok-4.7:xhigh"],
    "swarm workers": "xai/grok-4.7:xhigh",
    "architect runners": ["claude-subscription/claude-opus-5-5:xhigh", "xai/grok-4.7:xhigh"],
    "interrogate reviewers": ["claude-subscription/claude-opus-5-5:xhigh", "xai/grok-4.7:xhigh"]
  }
}
```

The provider names above are examples; write the ones step 1 detected. Delete a role to fall back to the skill default. `inherit-parent` or `auto` as a value runs the role on the parent chat's model. Alias entries in a panel list still count toward its fan-out.
