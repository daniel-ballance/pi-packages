# House policies win over vendored defaults

p3stack routes work through skills from four upstreams that disagree on purpose: pstack proceeds without waiting, Matt Pocock's skills wait until every decision is settled, superpowers gates building on an approved design, and agent-skills stops on any confusion. Loaded together, the same ambiguity can require a question, forbid one, and require a logged ruling. We settle each such conflict once, in a short **House policies** section of the `p3stack-mode` router, and let it win over any routed skill. The Grant, now explicit session state, decides which side of the authority policy applies.

The policies are authority, question sorting (look up facts, prototype what is observable or easier to show, ask only preferences), validation at trust boundaries, migration by consumer topology, testing at agreed seams with one prototype carve-out, review independence (artifact and contract, never the author's conclusion), fresh versus resumed children, and one house style. The comparison behind each is in the skills analysis that preceded this change.

## Considered options

- **Patch each vendored skill to agree**: rejected. It multiplies overlays and patches that break on every upstream bump, and the conflict reappears whenever a new skill arrives.
- **Pick one upstream's stance wholesale**: rejected. Each stance is right for some phases: interviews before building, autonomy once the human has delegated.
- **Leave it to the model**: rejected. Precedence that depends on which skill loaded last is not reviewable.

## Consequences

The router grows by about 350 words, read on every task, so each policy stays one or two sentences and its rationale lives here. Vendored text that a policy overrides keeps its upstream wording; the router states the precedence. A behavior change to a policy is measured with the routing eval and recorded in `docs/evals/rejected.md` when evidence rejects it.
