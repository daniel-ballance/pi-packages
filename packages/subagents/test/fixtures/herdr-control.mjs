import { appendFileSync } from "node:fs";
// herdr e2e control: parent lifecycle log plus a herdr:blocked emitter.
export default function (pi) {
  const log = (line) => process.env.HERDR_E2E_LOG && appendFileSync(process.env.HERDR_E2E_LOG, `${Date.now()} ${line}\n`);
  pi.on("session_start", (e, ctx) => log(`session_start ${e.reason} mode=${ctx.mode}`));
  pi.on("agent_start", () => log("agent_start"));
  pi.on("agent_settled", (_e, ctx) => log(`agent_settled idle=${ctx.isIdle()}`));
  pi.registerCommand("blocked", { handler: async (args) => {
    log(`blocked ${args.trim()}`);
    pi.events.emit("herdr:blocked", { active: args.trim() === "on", label: "e2e approval" });
  } });
}
