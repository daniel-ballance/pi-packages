import { spawnSync } from "node:child_process";
import { readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { onGraderCopy } from "./copy.mjs";

// The grader supplies the fixture's versions, never ones selected or installed by the agent.
const { devDependencies } = JSON.parse(readFileSync(new URL("../fixtures/source-grounding/base/package.json", import.meta.url)));
export function coverageModules(dir = process.env.P3STACK_EVAL_VITEST_DIR) {
  if (!dir) throw new Error("Set P3STACK_EVAL_VITEST_DIR to the provisioned source-grounding runtime (see docs/evals)");
  const modules = resolve(dir, "node_modules");
  for (const [name, version] of Object.entries(devDependencies)) {
    const path = join(modules, name, "package.json");
    if (JSON.parse(readFileSync(path)).version !== version) throw new Error(`Coverage grader requires ${name}@${version}`);
  }
  return modules;
}

function runTests(copy) {
  const result = spawnSync("npm", ["test"], { cwd: copy, env: { ...process.env, CI: "1", NO_COLOR: "1", npm_config_offline: "true" }, encoding: "utf8", timeout: 45000 });
  if (result.error) throw result.error;
  return result;
}

export function enforcesThreshold(project, modules, run = runTests) {
  return onGraderCopy(project, copy => {
    symlinkSync(modules, join(copy, "node_modules"), "dir");
    // Same config, npm script and source/test paths in both runs. Only the number of exercised lines changes.
    const branches = Array.from({ length: 100 }, (_, i) => `case ${i}: return ${i};`);
    writeFileSync(join(copy, "src/mean.ts"), `export function mean(n: number) {\n switch (n) {\n${branches.join("\n")}\n }\n}\n`);
    const sample = count => {
      writeFileSync(join(copy, "test/mean.test.ts"), `import { test, expect } from 'vitest';\nimport { mean } from '../src/mean';\ntest('coverage sample', () => { for (let i = 0; i < ${count}; i++) expect(mean(i)).toBe(i); });\n`);
      return run(copy);
    };
    if (sample(81).status !== 0) return false;
    const low = sample(79);
    return low.status === 1 && /Coverage for lines \(([\d.]+)%\) does not meet (?:global )?threshold \(80%\)/.test(low.stdout + low.stderr);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = enforcesThreshold(process.cwd(), coverageModules()) ? 0 : 1;
}
