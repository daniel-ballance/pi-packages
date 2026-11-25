import { defineTool, generateDiffString, renderDiff, type ExtensionAPI, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { detectHost, registerHostAware } from "./host.js";
import { asRecord, questionChoices, selection, type Diff } from "./observed.js";
import { withSignal } from "./errors.js";
import type { Antigravity } from "./provider.js";
import { STAND_IN } from "./tools.js";

const parameters = Type.Object({ title: Type.String(), kind: Type.Optional(Type.String()), input: Type.Optional(Type.Unknown()) });
type Details = { diff?: Diff[] };
const result = (text: string, details: Details = {}, isError = false) => ({ content: [{ type: "text" as const, text }], details, isError });

export function registerStandIn(pi: ExtensionAPI, bridge: Antigravity, loadoutChanged: () => void): void {
  const host = detectHost();
  const unavailable = (ctx: ExtensionToolContext) => !ctx.hasUI ? `No interactive ${host === "t3" ? "T3 Code" : "Pi"} UI is available; Antigravity's question was cancelled.` : undefined;
  const tool = defineTool({
    name: STAND_IN, label: "Antigravity", description: "Represent work delegated to the Antigravity CLI.",
    parameters, exposure: "direct",
    prepareLoadout: () => { loadoutChanged(); return { hiddenDeclarations: [STAND_IN] }; },
    reachesTools: input => {
      const name = asRecord(input.input)?.name;
      return input.kind === "pi_tool" && typeof name === "string" ? [name] : [];
    },
    async execute(id, _args, signal, onUpdate, ctx) {
      const route = bridge.route(ctx.sessionManager.getSessionId(), id);
      if (!route) return result("This Antigravity call is no longer pending in this Pi session.", {}, true);
      const abort = () => route.abort();
      signal?.addEventListener("abort", abort, { once: true });
      try {
        if (signal?.aborted) { abort(); return result("Antigravity call aborted.", {}, true); }
        if (route.kind === "mcp") {
          const nested = await ctx.executeTool(route.name, route.args, { signal: signal ? AbortSignal.any([signal, route.signal]) : route.signal, onUpdate });
          return { ...nested.result, details: {}, isError: nested.isError };
        }
        const { call } = route;
        if (call.kind === "question") {
          const pending = call.pendingPermission;
          if (!pending) return result("Antigravity's question is no longer pending.");
          const noUI = unavailable(ctx);
          const choices = questionChoices(pending.options);
          const select = !noUI && choices.length ? ctx.ui.select(call.title, choices, { signal }) : Promise.resolve(undefined);
          const chosen = await (signal ? withSignal(select, signal) : select);
          const option = chosen === undefined ? undefined : pending.options[choices.indexOf(chosen)];
          pending.answer(selection(option?.optionId));
          return result(option ? `Selected: ${option.name}` : noUI ?? "Antigravity's question was cancelled.");
        }
        route.approve();
        await route.wait(() => onUpdate?.(result(call.output ?? call.status, { diff: call.diff })), signal);
        return result(route.detached ?? call.output ?? call.status, { diff: call.diff }, call.status === "failed");
      } catch (error) {
        if (signal?.aborted) abort();
        else if (route.kind === "native") route.reject();
        return result(error instanceof Error ? error.message : String(error), {}, true);
      } finally {
        signal?.removeEventListener("abort", abort);
      }
    },
    renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold(String(args.title ?? "Antigravity"))), 0, 0); },
    renderResult(output, options, theme) {
      const text = output.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
      const diffs = (output.details as Details | undefined)?.diff ?? [];
      const lines = options.expanded ? text : text.split("\n").slice(0, 8).join("\n");
      return new Text([lines, ...diffs.map(diff => `${theme.fg("muted", diff.path)}\n${renderDiff(generateDiffString(diff.oldText, diff.newText).diff)}`)].filter(Boolean).join("\n"), 0, 0);
    },
  });
  registerHostAware(pi, tool, { duplicatesT3: false });
}
