### Prototype

**You own the design decision, not the code. The prototype is a throwaway instrument. The real build follows Feature.**

The one playbook where the Laziness Protocol's "smallest change" and the verification bar invert. Speed over polish, code quality does not matter, no planning. The rigor is in picking the right design cheaply. Propose variations the user didn't ask for, throw an approach away and try another.

1. Scope the decision the prototype exists to make: which layout, which interaction, which density, or for an empirical fork which behavior, timing, or approach. No decision means no prototype. Route to Feature.

> **p3stack only:** [interactive-prototype](../interactive-prototype/SKILL.md) — A human will choose, try, or judge the result: they ask to pick between options ("so I can pick one"), to see or click through it, or name someone else who will ("the PM", "the team"); or a stakeholder must drive it. Then this is the human-judged path for logic and UI alike. Build per its logic or UI branch in step 3: one shareable HTML file around a pure module, or variants on the real route on a prototype/<name> branch in its own worktree.

2. Gather references when the design space is open. Search for prior art, summarize a moodboard of themes, palettes, and layouts, let the user pick directions before building. Skip when the direction is set.
3. Build throwaway in an isolated scratch dir, separate from production source. For a visual decision, vanilla HTML/CSS/JS or the lightest stack that renders the idea, CDN deps, a dev server with hot reload. For a behavioral or timing decision, the smallest script that exercises the question. No production framework, no tests, no abstractions.
4. When comparing alternatives, build them behind one switcher (buttons or a keypress), each variant labeled. This is the **exhaust-the-design-space** principle skill made cheap.

> **p3stack only:** [host-capabilities](../poteto-mode/references/host-capabilities.md) — When a human will judge the prototype, follow **Drive the app** to try every variant or walkthrough before handoff.

5. Verify on the matching surface. For a visual decision, screenshot each variant via the control skill and drive the interaction. For a behavioral or timing decision, observe the thing you are deciding by logging the timing, printing the output, or watching the render. The observation is the test here, not an assertion.
6. Present alternatives, tradeoffs, and a recommendation. The output is the decision plus the throwaway artifact, not shippable code. Hand the chosen direction to **Feature** (or `architect` for the shape) for the real build.

> **p3stack only:** [interactive-prototype](../interactive-prototype/SKILL.md) — A human judges it. Default grant: hand it over with ask_user and wait for the verdict. Full autonomy: report your recommendation and continue. Then capture it per its Capture rule: lift the validated module, keep the prototype branch, and link it from the issue or PR.

**Reply:** the variants explored, the evidence (screenshots for a visual decision, the observed output or timing for a behavioral one), tradeoffs, your recommendation, and the scratch path. Say plainly that the prototype is throwaway.
