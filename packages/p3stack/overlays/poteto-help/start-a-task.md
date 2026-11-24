## Start a task in Pi

Type `/p3stack on` to enable the [router](../p3stack-mode/SKILL.md) for this session with the default grant. Then send the goal and a check that can pass or fail. The router selects the skill or playbook; there is no need to prefix every task. Under the default grant the agent asks about product choices. Use `/p3stack on autonomous` for the other grant: the agent makes covered choices and reports them. Explicit operator gates and irreversible actions still pause.

Type `/p3stack off` to turn the router off. For one skill with the mode off, use `/skill:<name>`, for example `/skill:how`. To help word the task, read [Word the prompt](references/prompting.md).
