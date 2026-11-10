import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const repository = fileURLToPath(new URL("../../../..", import.meta.url));

test("CI installs only the Pi version in the lockfiles and refuses any other runtime before installing anything", async (): Promise<void> => {
  for (const version of ["0.99.2", "1.2.0", "latest"]) {
    await assert.rejects(
      execute("bash", [join(repository, "scripts/ci-install.sh"), version], { cwd: repository, timeout: 10_000 }),
      (error: { code?: number; stderr?: string }) => error.code === 2 && /CI installs only the Pi version in the lockfiles/.test(error.stderr ?? ""),
      version,
    );
  }
});
