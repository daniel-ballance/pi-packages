# p3stack

Tell Pi what you want to build, fix, or review. With p3stack on, Pi chooses an engineering playbook and can delegate work. For example, a bug report without a failing reproduction starts with diagnosis rather than an edit. The same playbooks work in terminal Pi and under T3 Code.

## Try it on your next change

With Node.js 22.19 or newer, Pi installed, and a model configured, run:

```sh
pi install git:github.com/daniel-ballance/pi-packages
```

Open Pi in a repository with an uncommitted change. Send these as **two messages**:

```text
/p3stack on
Review my uncommitted change before I open a PR. Show me the evidence for each finding. Don't edit files or open a PR.
```

Look for a review of your diff, including any skipped tests or weakened checks, not just a review plan. No changes yet? Try “Explain where requests enter this repo and trace one to storage. Don't change any files.”

`/p3stack off` stops automatic routing. You can still invoke any of the 46 skills, such as `/skill:tdd`. For a former command, `/skill:poteto-help` lists its owner and reference. Run `pi list` in your shell to check the install. In Pi, `/p3stack status` reports whether routing is on. When on, the mode and grant appear in the terminal footer marker or as a status near the composer in T3 Code.

## Choose who decides

| In Pi | Effect |
|---|---|
| `/p3stack on default` | Ask me about product choices. A fresh session starts with routing off and this grant. Bare `on` reuses the last grant. |
| `/p3stack on autonomous` | Decide covered choices and report them. Explicit operator gates and irreversible actions still pause. |
| `/p3stack grant default` | Change the saved grant while routing is on. The other choice is `autonomous`. If routing is off, the command changes nothing and says so. |

An explicit request for full autonomy raises the grant for that task without changing the saved grant. In print or JSON mode, pass the switch and task in the same invocation:

```sh
pi --mode json --no-session '/p3stack on default' 'Explain how requests enter this repository. Do not edit files.'
```

`ask_user` waits for an answer for as long as the question is open. For an RPC client that may never answer, set `P3STACK_ASK_TIMEOUT_MS` to a deadline in milliseconds; it covers free text after a choice too. A timeout is reported as no answer, not as a dismissal or an approval. Terminal dialogs have no deadline.

## Install choices and setup

The Git command installs the [six-package collection](https://github.com/daniel-ballance/pi-packages#install-from-github). To install **only p3stack** from a checkout, run from the repository root:

```sh
npm ci --ignore-scripts
pi install "$PWD/packages/p3stack"
```

Choose one source, not both. Use Git or a checkout for the TypeScript playbook helpers. Node does not run them directly under `node_modules`.

To set child model defaults, run `/p3stack-setup` in interactive Pi on either host. Terminal Pi uses the included subagents catalog when available. T3 Code uses its own delegation catalog. If the session has no T3 catalog yet, ask Pi to call `p3stack_roles` once, then rerun setup.

Setup writes `p3stack.json` in Pi's agent directory (`PI_CODING_AGENT_DIR` when set, otherwise `~/.pi/agent`). For a T3 startup or duplicate-provider problem, see [T3 setup and `/p3stack doctor`](https://github.com/daniel-ballance/pi-packages/blob/main/packages/p3stack/docs/landing/t3-settings.md).

## Maintainers

Read [how routing works](https://github.com/daniel-ballance/pi-packages/blob/main/docs/p3stack.md) and [where to edit and how to check](https://github.com/daniel-ballance/pi-packages/blob/main/packages/p3stack/AGENTS.md). The installed `skills/` tree is generated. In a development checkout, `/skill:maintain-p3stack` audits the current pins. Request an upstream bump explicitly to change them.

## License and upstreams

MIT. See [LICENSE](LICENSE), [LICENSE-matt-pocock](LICENSE-matt-pocock), [LICENSE-agent-skills](LICENSE-agent-skills), and [LICENSE-superpowers](LICENSE-superpowers).

<!-- p3stack:upstream -->`cursor/plugins` [`3dbd22f`](https://github.com/cursor/plugins/tree/3dbd22ff12742fb28c9700b9760baa29ed41dc13/pstack), pstack 0.15.36; `mattpocock/skills` [`5863806`](https://github.com/mattpocock/skills/tree/5863806dd4e15c63174bee4e7515a4256792ecfa); `cursor/plugins` [`3dbd22f`](https://github.com/cursor/plugins/tree/3dbd22ff12742fb28c9700b9760baa29ed41dc13); `addyosmani/agent-skills` [`39b723c`](https://github.com/addyosmani/agent-skills/tree/39b723ceebf81474d0557c1fecd01eddab585563), agent-skills 0.6.16; `obra/superpowers` [`22f0b46`](https://github.com/obra/superpowers/tree/22f0b463e7a5e579904dd6211a520321035526f7)<!-- /p3stack:upstream -->.
