import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerAsk } from "./src/ask.ts";
import { registerBrief } from "./src/brief.ts";
import { registerMode } from "./src/mode.ts";
import { registerRoles } from "./src/roles.ts";
import { registerSetup } from "./src/setup.ts";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const modeSkill = join(packageDir, "skills", "poteto-mode", "SKILL.md");
const agentRecipe = join(packageDir, "agents", "poteto-agent.md");

export default function p3stack(pi: ExtensionAPI) {
  const isOn = registerMode(pi, modeSkill);
  const briefHeaders = registerBrief(pi, isOn, modeSkill, agentRecipe);
  registerAsk(pi);
  registerRoles(pi, briefHeaders);
  registerSetup(pi);
}
