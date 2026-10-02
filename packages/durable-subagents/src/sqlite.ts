import { chmod, lstat, mkdir, open, realpath, rmdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { hostname } from 'node:os';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { DurableSubagents, type HostOptions } from './runtime.js';

/** Fail-closed process ownership, intentionally no timed stale-lock takeover.
 * A killed owner leaves this directory behind. An operator must verify that no process owns
 * the database and remove the lock directory before recovery. PID reuse is not proof of ownership.
 * The lock is advisory: all hosts must use this opener; raw SQLite clients can ignore it. */
export async function openSqliteSubagents(path: string, options: Omit<HostOptions, 'storage'>) {
  const absolute = resolve(path);
  await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
  const directory = await realpath(dirname(absolute));
  const canonical = await realpath(absolute).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    const leaf = await lstat(absolute).catch((missing: NodeJS.ErrnoException) => { if (missing.code !== 'ENOENT') throw missing; return undefined; });
    if (leaf?.isSymbolicLink()) throw new Error('Dangling SQLite symlink is not supported for exclusive ownership');
    return resolve(directory, basename(absolute));
  });
  const existing = await stat(canonical).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return undefined; });
  if (existing && existing.nlink !== 1) throw new Error('Hard-linked SQLite database is not supported for exclusive ownership');
  const lock = `${canonical}.lock`;
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Session already owned or stale lock requires operator review: ${lock}`);
    throw error;
  }
  const ownerFile = `${lock}/owner.json`;
  await writeFile(ownerFile, JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString() }), { mode: 0o600 });
  const unlock = async () => {
    const { unlink } = await import('node:fs/promises');
    await unlink(ownerFile); await rmdir(lock);
  };
  let storage: Awaited<ReturnType<typeof openNodeSqliteStorage>> | undefined;
  try {
    // SQLite derives new WAL/SHM modes from the database; set them before it opens.
    try { const file = await open(canonical, 'ax', 0o600); await file.close(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    for (const file of [canonical, `${canonical}-wal`, `${canonical}-shm`]) {
      const info = await lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return undefined; });
      if (!info) continue;
      if (!info.isFile() || info.nlink !== 1) throw new Error('SQLite files must be regular, single-link files');
      await chmod(file, 0o600);
    }
    storage = await openNodeSqliteStorage(canonical);
    const host = await DurableSubagents.open({ ...options, storage });
    const close = host.close.bind(host);
    let closed = false;
    host.close = async context => {
      if (closed) return;
      await close(context);
      await unlock();
      closed = true;
    };
    return host;
  } catch (error) {
    if (storage) await storage.close(BACKGROUND_CONTEXT);
    await unlock();
    throw error;
  }
}
