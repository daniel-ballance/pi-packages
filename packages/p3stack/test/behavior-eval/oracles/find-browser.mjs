import { spawnSync } from "node:child_process";

export function findBrowser() {
  const named = process.env.P3STACK_EVAL_CHROMIUM;
  for (const name of named ? [named] : ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]) {
    if (spawnSync(name, ["--version"], { stdio: "ignore" }).status === 0) return name;
  }
}
