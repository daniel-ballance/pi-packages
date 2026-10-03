import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
/** Portable Durable SQL facade backed by Bun's native SQLite. This serializes
 * one database connection, not conversation work; native Durable owns all tasks. */
export class BunSqliteDatabase {
    database;
    tail = Promise.resolve();
    closed = false;
    constructor(database) {
        this.database = database;
    }
    serialize(operation) {
        const result = this.tail.then(operation);
        this.tail = result.catch(() => undefined);
        return result;
    }
    executor(active) {
        const check = () => { if (!active() || this.closed)
            throw new Error('SQLite handle is no longer active'); };
        return {
            exec: async (sql) => { check(); this.database.exec(sql); },
            run: async (sql, ...params) => { check(); this.database.query(sql).run(...params); },
            get: async (sql, ...params) => { check(); return this.database.query(sql).get(...params) ?? undefined; },
            all: async (sql, ...params) => { check(); return this.database.query(sql).all(...params); },
        };
    }
    exec(sql) { return this.serialize(() => this.executor(() => true).exec(sql)); }
    run(sql, ...params) { return this.serialize(() => this.executor(() => true).run(sql, ...params)); }
    get(sql, ...params) { return this.serialize(() => this.executor(() => true).get(sql, ...params)); }
    all(sql, ...params) { return this.serialize(() => this.executor(() => true).all(sql, ...params)); }
    transaction(callback) {
        return this.serialize(async () => {
            if (this.closed)
                throw new Error('SQLite database is closed');
            this.database.exec('BEGIN IMMEDIATE');
            let active = true;
            try {
                const result = await callback(this.executor(() => active));
                active = false;
                this.database.exec('COMMIT');
                return result;
            }
            catch (error) {
                active = false;
                try {
                    this.database.exec('ROLLBACK');
                }
                catch (rollback) {
                    throw new AggregateError([error, rollback], 'SQLite transaction and rollback failed');
                }
                throw error;
            }
        });
    }
    close() {
        return this.serialize(() => {
            if (this.closed)
                return;
            this.closed = true;
            try {
                this.database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
            }
            finally {
                this.database.close();
            }
        });
    }
}
export async function openBunSqliteStorage(path) {
    // Dynamic builtin import keeps this module/build usable on Node as well.
    const builtin = 'bun:sqlite';
    const { Database } = await import(builtin);
    const database = new BunSqliteDatabase(new Database(path, { create: true, strict: true }));
    try {
        await database.exec('PRAGMA journal_mode = WAL');
        await database.exec('PRAGMA synchronous = NORMAL');
        await database.exec('PRAGMA busy_timeout = 5000');
        await database.exec('PRAGMA wal_autocheckpoint = 1000');
        return await SqliteStorage.open(database);
    }
    catch (error) {
        await database.close().catch(() => undefined);
        throw error;
    }
}
