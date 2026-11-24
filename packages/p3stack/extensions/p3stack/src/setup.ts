import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Pi } from "./mode.ts";
import { agentDir, BUDGETS, candidates, CODE_ROLES, JUDGMENT_ROLES, PANEL_ROLES, setupCatalog } from "./roles.ts";

export function registerSetup(pi: Pi & Partial<Pick<ExtensionAPI, "sendMessage">>) {
  pi.registerCommand("p3stack-setup", {
    description: "Choose a thinking budget, a code model and a judgment model, and write personal defaults for every p3stack role",
    handler: async (_args, ctx) => {
      const path = join(agentDir(), "p3stack.json");
      if (!ctx.hasUI) {
        pi.sendMessage?.({ customType: "p3stack-setup", content: `No UI to choose role models. Nothing written to ${path}.`, display: true });
        return;
      }
      let catalog: string[] | undefined;
      try { catalog = setupCatalog(pi); } catch (error) { ctx.ui.notify((error as Error).message, "warning"); return; }
      const models = catalog ? [] : ctx.modelRegistry.getAvailable();
      if (!(catalog ?? models).length) { ctx.ui.notify("No models with advertised thinking levels are available. Nothing written.", "warning"); return; }
      const budgetLabel = await ctx.ui.select("Thinking budget for p3stack roles", BUDGETS.map(budget => budget.label));
      const budget = BUDGETS.find(entry => entry.label === budgetLabel);
      if (!budget) { ctx.ui.notify("Setup cancelled. Nothing written.", "info"); return; }
      const names = candidates(budget.name, models, catalog);
      if (!names.length) { ctx.ui.notify(`No permitted model offers thinking at or below ${budget.level}. Choose a larger budget or change the catalog. Nothing written.`, "warning"); return; }
      const code = await ctx.ui.select("Model for code roles (feature, bug-fix, swarm workers, explorers)", names);
      if (!code || !names.includes(code)) { ctx.ui.notify("Setup cancelled. Nothing written.", "info"); return; }
      const judgment = candidates(budget.name === "small" ? "medium" : budget.name, models, catalog);
      const atFloor = judgment.filter(name => /:(high|xhigh|max)$/.test(name));
      const gap = atFloor.length ? "" : "No offered model reaches high thinking for judgment within this budget.";
      const choices = atFloor.length ? atFloor : judgment;
      const judge = await ctx.ui.select(`Model for judgment, review and prose roles. ${gap ? `${gap} Choose a lower level or cancel.` : "A different family suits review panels."}`, choices);
      if (!judge || !choices.includes(judge)) { ctx.ui.notify("Setup cancelled. Nothing written.", "info"); return; }
      const roles = Object.fromEntries([
        ...CODE_ROLES.map(role => [role, code]), ...JUDGMENT_ROLES.map(role => [role, judge]),
        ...PANEL_ROLES.map(role => [role, [judge, code]]),
      ]);
      const label = `${budget.name} (${budget.level})`;
      if (existsSync(path) && !await ctx.ui.confirm("Replace the role defaults?", `${path} exists. Setup rewrites it whole.`)) { ctx.ui.notify("Kept the existing file.", "info"); return; }
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({ budget: label, roles }, null, 2) + "\n");
      ctx.ui.notify(`Wrote ${path}. Budget: ${label}. Code roles: ${code}. Judgment roles: ${judge}. Panels: [${judge}, ${code}].${gap ? ` ${gap}` : ""}`, "info");
    },
  });
}
