import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { detectHost } from "./host.ts";
import type { Pi } from "./mode.ts";
import { agentDir, BUDGETS, candidates, CODE_ROLES, JUDGMENT_ROLES, PANEL_ROLES, readCatalog } from "./roles.ts";

export function registerSetup(pi: Pi) {
  pi.registerCommand("p3stack-setup", {
    description: "Choose a thinking budget, a code model and a judgment model, and write ~/.pi/agent/p3stack.json for every p3stack role",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      if (detectHost() === "t3") { ctx.ui.notify("Under T3 Code, run /skill:setup-pstack to read T3's model catalog.", "info"); return; }
      const withSubagents = pi.getAllTools().some(tool => tool.name === "subagent_catalog");
      const catalog = withSubagents ? readCatalog(pi) : undefined;
      if (withSubagents) {
        if (!catalog) { ctx.ui.notify("This subagents version cannot share its catalog with a command. Run /skill:setup-pstack to read subagent_catalog.", "info"); return; }
        if (!catalog.spawnEnabled) { ctx.ui.notify("Your subagents policy does not permit spawning, so no role can run. Check subagent_catalog or /subagents diagnostics.", "warning"); return; }
      }
      const models = ctx.modelRegistry.getAvailable();
      if (!catalog && !models.length) { ctx.ui.notify("No models are available to Pi. Configure one first.", "warning"); return; }
      const budgetLabel = await ctx.ui.select("Thinking budget for p3stack roles", BUDGETS.map(budget => budget.label));
      const budget = BUDGETS.find(entry => entry.label === budgetLabel);
      if (!budget) { ctx.ui.notify("Setup cancelled. Nothing written.", "info"); return; }
      const names = candidates(budget.name, models, catalog?.models);
      if (!names.length) { ctx.ui.notify(`No ${catalog ? "permitted " : ""}model offers thinking at or below ${budget.level}. Choose a larger budget${catalog ? " or permit more models in subagents.json" : ""}.`, "warning"); return; }
      const code = await ctx.ui.select("Model for code roles (feature, bug-fix, swarm workers, explorers)", names);
      const judgment = code && await ctx.ui.select("Model for judgment and prose roles (a different family suits review panels)", names);
      if (!code || !judgment) { ctx.ui.notify("Setup cancelled. Nothing written.", "info"); return; }
      const roles = Object.fromEntries([
        ...CODE_ROLES.map(role => [role, code]), ...JUDGMENT_ROLES.map(role => [role, judgment]),
        ...PANEL_ROLES.map(role => [role, [judgment, code]]),
      ]);
      const path = join(agentDir(), "p3stack.json");
      if (existsSync(path) && !await ctx.ui.confirm("Replace the role defaults?", `${path} exists. Setup rewrites it whole.`)) { ctx.ui.notify("Kept the existing file.", "info"); return; }
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({ budget: `${budget.name} (${budget.level})`, roles }, null, 2) + "\n");
      ctx.ui.notify(`Wrote ${path}. Code roles use ${code}, judgment roles use ${judgment}.${catalog ? " Both are permitted by your subagents policy." : ""}`, "info");
    },
  });
}
