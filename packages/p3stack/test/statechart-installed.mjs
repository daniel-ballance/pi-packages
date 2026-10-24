import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Probe installed tools without calling upstream's auto-provisioning helpers.
export function installedTlc(tlcTool, javaTool, {
  env = process.env, exists = existsSync, run = spawnSync,
} = {}) {
  const probe = args => {
    const result = run("mise", args, { encoding: "utf8", env });
    return result.status === 0 ? result.stdout.trim() : "";
  };
  const home = env.TLA2TOOLS ? "" : probe(["where", tlcTool]);
  const jar = env.TLA2TOOLS || (home && join(home, "tla2tools.jar"));
  const java = env.JAVA || probe(["which", "java", "--tool", javaTool]);
  return jar && exists(jar) && java && exists(java) ? { jar, java } : null;
}

export async function installedRenderer(dir, { exists = existsSync, load = url => import(url) } = {}) {
  const entry = join(dir, "entry.mjs");
  if (!exists(entry)) return null;
  try { return await load(pathToFileURL(entry).href); }
  catch { return null; }
}
