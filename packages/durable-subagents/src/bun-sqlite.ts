import { SqliteStorage, type SqliteDatabase, type SqliteExecutor, type SqliteValue } from '@earendil-works/pi-durable/storage/sqlite';

interface BunDatabase {
  exec(sql: string): void;
  query(sql: string): {
    run(...params: SqliteValue[]): unknown;
    get(...params: SqliteValue[]): object | null;
    all(...params: SqliteValue[]): object[];
  };
  close(): void;
}

/** Portable Durable SQL facade backed by Bun's native SQLite. This serializes
 * one database connection, not conversation work; native Durable owns all tasks. */
export class BunSqliteDatabase implements SqliteDatabase {
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  constructor(private readonly database: BunDatabase) {}
  private serialize<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => undefined);
    return result;
  }
  private executor(active: () => boolean): SqliteExecutor {
    const check = () => { if (!active() || this.closed) throw new Error('SQLite handle is no longer active'); };
    return {
      exec: async sql => { check(); this.database.exec(sql); },
      run: async (sql, ...params) => { check(); this.database.query(sql).run(...params); },
      get: async <T extends object>(sql: string, ...params: SqliteValue[]) => { check(); return this.database.query(sql).get(...params) as T | null ?? undefined; },
      all: async <T extends object>(sql: string, ...params: SqliteValue[]) => { check(); return this.database.query(sql).all(...params) as T[]; },
    };
  }
  exec(sql: string) { return this.serialize(() => this.executor(() => true).exec(sql)); }
  run(sql: string, ...params: SqliteValue[]) { return this.serialize(() => this.executor(() => true).run(sql, ...params)); }
  get<T extends object>(sql: string, ...params: SqliteValue[]) { return this.serialize(() => this.executor(() => true).get<T>(sql, ...params)); }
  all<T extends object>(sql: string, ...params: SqliteValue[]) { return this.serialize(() => this.executor(() => true).all<T>(sql, ...params)); }
  transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
    return this.serialize(async () => {
      if (this.closed) throw new Error('SQLite database is closed');
      this.database.exec('BEGIN IMMEDIATE');
      let active = true;
      try {
        const result = await callback(this.executor(() => active));
        active = false; this.database.exec('COMMIT'); return result;
      } catch (error) {
        active = false;
        try { this.database.exec('ROLLBACK'); }
        catch (rollback) { throw new AggregateError([error, rollback], 'SQLite transaction and rollback failed'); }
        throw error;
      }
    });
  }
  close(): Promise<void> {
    return this.serialize(() => {
      if (this.closed) return;
      this.closed = true;
      try { this.database.exec('PRAGMA wal_checkpoint(TRUNCATE)'); }
      finally { this.database.close(); }
    });
  }
}

export async function openBunSqliteStorage(path: string) {
  // Dynamic builtin import keeps this module/build usable on Node as well.
  const builtin = 'bun:sqlite';
  const { Database } = await import(builtin) as { Database: new (path: string, options: { create: boolean; strict: boolean }) => BunDatabase };
  const database = new BunSqliteDatabase(new Database(path, { create: true, strict: true }));
  try {
    await database.exec('PRAGMA journal_mode = WAL');
    await database.exec('PRAGMA synchronous = NORMAL');
    await database.exec('PRAGMA busy_timeout = 5000');
    await database.exec('PRAGMA wal_autocheckpoint = 1000');
    return await SqliteStorage.open(database);
  } catch (error) { await database.close().catch(() => undefined); throw error; }
}
