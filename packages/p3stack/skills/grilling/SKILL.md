---
name: grilling
description: Grill the user relentlessly about a plan, decision, or idea. Use when the user wants to stress-test their thinking, or uses any 'grill' trigger phrases.
---

Read [child delegation guidance](../poteto-mode/references/host-capabilities.md) before using child delegation.

When checking that you understood the user's goal, read [in-your-own-words](references/in-your-own-words.md) before the next interview round.

For a design with no interview or under full autonomy, use [architect](../architect/SKILL.md) for a recommendation and stop. With the human present, open with one open question about why they want the change, without suggested answers.

Map the remaining preferences as a **design tree**: every decision branches into the decisions that hang off it.

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled: the questions you can ask _now_ without guessing at answers you haven't heard yet. Ask the whole frontier in one round: number each question and give your recommended answer. Then wait for the user's answers before the next round.

Format a round like so:

```
❓ **Q1** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>

---

❓ **Q2** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>
```

In follow-up rounds, word each question so "yes" accepts your recommended answer.

Each round the user answers reshapes the tree: settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one.

Facts are your job, never the user's. For a non-trivial environment investigation, when child and retrieval tools are available, spawn a bounded child with a fresh context window to gather it. For a trivial lookup, or when those tools are unavailable, inspect it directly. Ask independent frontier questions now and wait only for dependent child work. Decisions remain the user's: ask and wait.

When the frontier is empty or your written hypothesis reaches about 95% confidence, return the design and any assumptions. Leave a required human approval pending until the human gives it.
