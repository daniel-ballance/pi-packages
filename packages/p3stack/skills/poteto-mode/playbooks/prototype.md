### Prototype

**You own the design decision, not the code. The prototype is a throwaway instrument. The real build follows Feature.**

The one playbook where the Laziness Protocol's "smallest change" and the verification bar invert. Speed over polish, code quality does not matter, no planning. The rigor is in picking the right design cheaply. Propose variations the user didn't ask for, throw an approach away and try another.

1. Scope the decision the prototype exists to make: which layout, which interaction, which density, or for an empirical fork which behavior, timing, or approach. If the decision is unclear, ask under default or state the question you inferred under full autonomy.

> **p3stack only:** [interactive-prototype](../interactive-prototype/SKILL.md) — When a human will choose, try or judge the demo (including a PM or team), replace step 3 with the logic or UI build. Stop that skill before Capture: one shareable HTML logic demo or switchable UI variants in a prototype worktree.

2. Gather references when the design space is open. Search for prior art, summarize a moodboard of themes, palettes, and layouts, and let the user pick under default or choose a direction under full autonomy. Skip when the direction is set.
3. Build throwaway in an isolated scratch dir, separate from production source. For a visual decision, vanilla HTML/CSS/JS or the lightest stack that renders the idea, CDN deps, a dev server with hot reload. For a behavioral or timing decision, the smallest script that exercises the question. No production framework, no tests, no abstractions.
4. When comparing alternatives, build them behind one switcher (buttons or a keypress), each variant labeled. This is the **exhaust-the-design-space** principle skill made cheap.

> **p3stack only:** [host-capabilities](../poteto-mode/references/host-capabilities.md) — For a human judge, use **Drive the app** for step 5. Exercise the variants or walkthroughs and report any unverified controls.

5. Verify on the matching surface. For a visual decision, screenshot each variant via the control skill and drive the interaction. For a behavioral or timing decision, observe the thing you are deciding by logging the timing, printing the output, or watching the render. The observation is the test here, not an assertion.

> **p3stack only:** [interactive-prototype](../interactive-prototype/SKILL.md) — For a human judge, stop at the checked demo before the Feature handoff. Return the artifact, evidence and recommendation. Under default, ask for the verdict if the judge is present. Under full autonomy or with an absent judge, mark a missing verdict pending.

6. Present alternatives, tradeoffs, and a recommendation. The output is the decision plus the throwaway artifact, not shippable code. Hand the chosen direction to **Feature** (or `architect` for the shape) for the real build.

**Reply:** the variants explored, the evidence (screenshots for a visual decision, the observed output or timing for a behavioral one), tradeoffs, your recommendation, and the scratch path. Say plainly that the prototype is throwaway.
