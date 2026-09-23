import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readdirSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Artifact { path: string; digest: string; summary: string }
/** Artifact trees contain ordinary files/directories, never links to mutable inputs. */
export function digestTree(path: string): string {
  const hash = createHash("sha256");
  const visit = (directory: string, prefix = "") => {
    if (!lstatSync(directory).isDirectory()) throw new Error("Artifact root must be an ordinary directory");
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name), relative = `${prefix}${name}`, stat = lstatSync(path);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error(`Artifact contains a link or special file: ${relative}`);
      hash.update(JSON.stringify([relative, stat.isDirectory() ? "directory" : "file", stat.mode & 0o777]));
      if (stat.isDirectory()) visit(path, `${relative}/`);
      else { const bytes = readFileSync(path); hash.update(String(bytes.length) + ":"); hash.update(bytes); }
    }
  };
  visit(path); return hash.digest("hex");
}
export function verifyArtifact(artifact: Artifact) {
  if (digestTree(artifact.path) !== artifact.digest) throw new Error(`Artifact changed after submission: ${artifact.path}`);
}
export function candidateDirectory(path: string, seed?: Artifact) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (seed) { verifyArtifact(seed); cpSync(seed.path, path, { recursive: true }); }
  return path;
}
export function snapshot(candidate: string, path: string, summary: string): Artifact {
  digestTree(candidate); // Reject symlinks before copying.
  cpSync(candidate, path, { recursive: true });
  writeFileSync(join(path, "response.md"), summary, { mode: 0o600 });
  return { path, digest: digestTree(path), summary: summary.slice(0, 12000) };
}
