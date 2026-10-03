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
export declare class BunSqliteDatabase implements SqliteDatabase {
    private readonly database;
    private tail;
    private closed;
    constructor(database: BunDatabase);
    private serialize;
    private executor;
    exec(sql: string): Promise<void>;
    run(sql: string, ...params: SqliteValue[]): Promise<void>;
    get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined>;
    all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]>;
    transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T>;
    close(): Promise<void>;
}
export declare function openBunSqliteStorage(path: string): Promise<SqliteStorage>;
export {};
