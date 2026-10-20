import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const generator = new URL("../generator/git-env.mjs", import.meta.url).href;
const compat = new URL("../skills/poteto-mode/scripts/bun-compat.ts", import.meta.url).href;
const repoVars = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY"];
const config = {
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "demo.key",
  GIT_CONFIG_VALUE_0: "kept",
  GIT_CONFIG_PARAMETERS: "'demo.other=also'",
};

for (const mode of ["generator", "sync", "async"]) {
  for (const fails of [false, true]) {
    test(`${mode} ${fails ? "falls back when discovery fails" : "discovers repository variables lazily"} and keeps command config`, { skip: process.platform === "win32" }, () => {
      const bin = realpathSync(mkdtempSync(join(tmpdir(), "p3stack-git-env-")));
      const log = join(bin, "calls");
      const output = join(bin, "env.json");
      writeFileSync(join(bin, "git"), `#!/bin/sh
if [ "$1" = rev-parse ]; then
  printf '%s\n' "$*" >> "$DISCOVERY_LOG"
  ${fails ? "exit 1" : `printf '%s\\n' ${[...repoVars, "GIT_FUTURE_LOCAL", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS"].join(" ")}`}
else
  "$NODE" -e 'require("node:fs").writeFileSync(process.env.ENV_OUTPUT, JSON.stringify(process.env))'
fi
`, { mode: 0o755 });
      try {
        const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
          import assert from "node:assert/strict";
          import { existsSync, readFileSync } from "node:fs";
          const helper = await import(${JSON.stringify(mode === "generator" ? generator : compat)});
          assert.equal(existsSync(process.env.DISCOVERY_LOG), false);
          const readEnv = async () => {
            if (${JSON.stringify(mode)} === "generator") return helper.gitEnv();
            if (${JSON.stringify(mode)} === "sync") {
              assert.equal(helper.Bun.spawnSync(["git", "env"]).exitCode, 0);
            } else {
              assert.equal(await helper.Bun.spawn(["git", "env"]).exited, 0);
            }
            return JSON.parse(readFileSync(process.env.ENV_OUTPUT, "utf8"));
          };
          const keys = ${JSON.stringify([...repoVars, "GIT_FUTURE_LOCAL", ...Object.keys(config), "KEEP"])};
          const pick = env => Object.fromEntries(keys.filter(key => env[key] !== undefined).map(key => [key, env[key]]));
          const first = pick(await readEnv());
          const second = pick(await readEnv());
          assert.equal(process.env.GIT_FUTURE_LOCAL, "remove");
          console.log(JSON.stringify({ first, second }));
        `], {
          encoding: "utf8",
          env: {
            ...process.env,
            ...Object.fromEntries(repoVars.map(name => [name, join(bin, "decoy")])),
            ...config,
            GIT_FUTURE_LOCAL: "remove",
            KEEP: "yes",
            PATH: bin,
            NODE: process.execPath,
            DISCOVERY_LOG: log,
            ENV_OUTPUT: output,
          },
        });
        assert.equal(result.status, 0, result.stderr);
        const expected = { ...config, KEEP: "yes", ...(fails ? { GIT_FUTURE_LOCAL: "remove" } : {}) };
        assert.deepEqual(JSON.parse(result.stdout), { first: expected, second: expected });
        assert.equal(readFileSync(log, "utf8"), "rev-parse --local-env-vars\n");
      } finally {
        rmSync(bin, { recursive: true, force: true });
      }
    });
  }
}
