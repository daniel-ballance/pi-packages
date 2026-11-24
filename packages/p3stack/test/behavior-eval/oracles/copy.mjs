import { cpSync, lstatSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

// Never edit the submission or follow a submitted link back out of the copy.
export function onGraderCopy(project, check) {
  const copy = mkdtempSync(join(tmpdir(), "p3stack-grader-"));
  try {
    cpSync(project, copy, { recursive: true, filter(path) {
      if ([".git", "node_modules"].includes(basename(path))) return false;
      const stat = lstatSync(path);
      return stat.isFile() || stat.isDirectory();
    } });
    return check(copy);
  } finally { rmSync(copy, { recursive: true, force: true }); }
}
