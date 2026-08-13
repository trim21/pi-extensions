/**
 * Storage abstraction for the talk store.
 *
 * The talk core (registry + mailbox) is written against this interface, so
 * the persistence backend can be swapped: today SQLite, later a remote/HTTP
 * service without touching the talk logic.
 *
 * The model is deliberately minimal and HTTP-friendly:
 * - a `namespace` is a collection;
 * - a `key` is a single entry inside a namespace;
 * - values are opaque JSON (validated by the core layer, not here);
 * - audit is an append-only log.
 *
 * `readJson` returns `unknown` on purpose: the core layer validates it with
 * TypeBox schemas, so a corrupt/foreign payload is rejected rather than
 * blindly cast.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface TalkStorage {
  /** Ensure the store is ready (create root, connect, handshake, etc.). */
  init(): Promise<void>;
  /** List all keys in a namespace, sorted. No side effects. */
  listKeys(namespace: string): Promise<string[]>;
  /** Read a JSON value by key; null when absent or not valid JSON. */
  readJson(namespace: string, key: string): Promise<unknown>;
  /** Atomically write a JSON value under a key. */
  writeJson(namespace: string, key: string, value: unknown): Promise<void>;
  /** Remove a key. Returns true when the key existed and was removed. */
  removeKey(namespace: string, key: string): Promise<boolean>;
  /** Whether a namespace holds at least one key. */
  hasKeys(namespace: string): Promise<boolean>;
  /** Remove an entire namespace and everything in it. */
  removeNamespace(namespace: string): Promise<void>;
  /** Append one line to a named log. */
  appendLog(logName: string, line: string): Promise<void>;
  /** Read all lines of a named log, oldest first. */
  readLog(logName: string): Promise<string[]>;
}

/**
 * SQLite backend (Node's built-in `node:sqlite`, no npm dependency).
 *
 * A single database file holds everything; WAL mode plus a busy timeout lets
 * multiple pi sessions read and write it concurrently. SQL parameter binding
 * removes the need for path/symlink hardening entirely.
 *
 * The backend is synchronous; each method wraps its result in a resolved
 * promise to satisfy the async interface that a future HTTP backend needs.
 */
export class SqliteTalkStorage implements TalkStorage {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    // A custom db_path may point into a directory that does not exist yet
    // (e.g. "~/data/talk.db"); sqlite refuses to open it, so create the
    // parent directory first.
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS talk_kv (
        namespace TEXT NOT NULL,
        key       TEXT NOT NULL,
        value     TEXT NOT NULL,
        PRIMARY KEY (namespace, key)
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS talk_log (
        name TEXT NOT NULL,
        seq  INTEGER PRIMARY KEY AUTOINCREMENT,
        line TEXT NOT NULL
      )
    `);
  }

  init(): Promise<void> {
    // schema is created in the constructor
    return Promise.resolve();
  }

  /** Close the underlying database handle (test teardown). */
  close(): void {
    this.db.close();
  }

  listKeys(namespace: string): Promise<string[]> {
    const rows = this.db
      .prepare("SELECT key FROM talk_kv WHERE namespace = ? ORDER BY key")
      .all(namespace) as unknown as { key: string }[];
    return Promise.resolve(rows.map((r) => r.key));
  }

  readJson(namespace: string, key: string): Promise<unknown> {
    const row = this.db
      .prepare("SELECT value FROM talk_kv WHERE namespace = ? AND key = ?")
      .get(namespace, key) as { value: string } | undefined;
    if (row === undefined) return Promise.resolve(null);
    try {
      return Promise.resolve(JSON.parse(row.value) as unknown);
    } catch {
      return Promise.resolve(null);
    }
  }

  writeJson(namespace: string, key: string, value: unknown): Promise<void> {
    this.db
      .prepare("INSERT OR REPLACE INTO talk_kv (namespace, key, value) VALUES (?, ?, ?)")
      .run(namespace, key, JSON.stringify(value));
    return Promise.resolve();
  }

  removeKey(namespace: string, key: string): Promise<boolean> {
    const result = this.db
      .prepare("DELETE FROM talk_kv WHERE namespace = ? AND key = ?")
      .run(namespace, key);
    return Promise.resolve(result.changes > 0);
  }

  hasKeys(namespace: string): Promise<boolean> {
    return Promise.resolve(
      this.db.prepare("SELECT 1 FROM talk_kv WHERE namespace = ? LIMIT 1").get(namespace) !==
        undefined,
    );
  }

  removeNamespace(namespace: string): Promise<void> {
    this.db.prepare("DELETE FROM talk_kv WHERE namespace = ?").run(namespace);
    return Promise.resolve();
  }

  appendLog(logName: string, line: string): Promise<void> {
    this.db.prepare("INSERT INTO talk_log (name, line) VALUES (?, ?)").run(logName, line);
    return Promise.resolve();
  }

  readLog(logName: string): Promise<string[]> {
    const rows = this.db
      .prepare("SELECT line FROM talk_log WHERE name = ? ORDER BY seq")
      .all(logName) as unknown as { line: string }[];
    return Promise.resolve(rows.map((r) => r.line));
  }
}
