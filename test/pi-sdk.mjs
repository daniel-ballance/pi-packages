import { execFileSync } from "node:child_process";

// Resolve through the workspace that depends on Pi, including pnpm's isolated install.
export const piSdk = execFileSync(process.execPath, ["--input-type=module", "-e",
  'console.log(import.meta.resolve("@earendil-works/pi-coding-agent"))'], {
  cwd: new URL("../packages/p3stack/subagents/", import.meta.url), encoding: "utf8",
}).trim();
