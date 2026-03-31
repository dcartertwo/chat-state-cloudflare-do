import { DurableObject } from "cloudflare:workers";

const LIST_KEY_PREFIX = "list:";
const QUEUE_KEY_PREFIX = "queue:";

interface QueueRow {
  expiresAt: number;
}

/**
 * Durable Object class providing persistent state for Chat SDK.
 *
 * Uses SQLite storage for subscriptions, distributed locks, and
 * key-value caching. Must be bound in your wrangler configuration
 * and re-exported from your Worker entrypoint.
 *
 * @example
 * ```typescript
 * // wrangler.toml
 * // [durable_objects]
 * // bindings = [{ name = "CHAT_STATE", class_name = "ChatStateDO" }]
 * //
 * // [[migrations]]
 * // tag = "v1"
 * // new_sqlite_classes = ["ChatStateDO"]
 *
 * // Worker entrypoint
 * export { ChatStateDO } from "chat-state-cloudflare-do";
 * ```
 */
export class ChatStateDO<TEnv = unknown> extends DurableObject<TEnv> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: TEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;

    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
    });
  }

  private migrate(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS _schema_version (
        version INTEGER PRIMARY KEY
      );
    `);

    const row = this.sql
      .exec<{
        version: number;
      }>("SELECT COALESCE(MAX(version), 0) as version FROM _schema_version")
      .one();

    if (row.version < 1) {
      this.sql.exec(`
        CREATE TABLE subscriptions (
          thread_id TEXT PRIMARY KEY
        );

        CREATE TABLE locks (
          thread_id TEXT PRIMARY KEY,
          token     TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        );

        CREATE TABLE cache (
          key        TEXT PRIMARY KEY,
          value      TEXT NOT NULL,
          expires_at INTEGER
        );

        CREATE INDEX idx_locks_expires ON locks(expires_at);
        CREATE INDEX idx_cache_expires ON cache(expires_at)
          WHERE expires_at IS NOT NULL;

        INSERT INTO _schema_version (version) VALUES (1);
      `);
    }
  }

  subscribe(threadId: string): void {
    this.sql.exec(
      "INSERT OR IGNORE INTO subscriptions (thread_id) VALUES (?)",
      threadId,
    );
  }

  unsubscribe(threadId: string): void {
    this.sql.exec("DELETE FROM subscriptions WHERE thread_id = ?", threadId);
  }

  isSubscribed(threadId: string): boolean {
    return (
      this.sql
        .exec(
          "SELECT 1 FROM subscriptions WHERE thread_id = ? LIMIT 1",
          threadId,
        )
        .toArray().length > 0
    );
  }

  acquireLock(
    threadId: string,
    ttlMs: number,
  ): { threadId: string; token: string; expiresAt: number } | null {
    const result = this.ctx.storage.transactionSync(() => {
      const now = Date.now();

      this.sql.exec(
        "DELETE FROM locks WHERE thread_id = ? AND expires_at <= ?",
        threadId,
        now,
      );

      const existing = this.sql
        .exec("SELECT 1 FROM locks WHERE thread_id = ? LIMIT 1", threadId)
        .toArray();

      if (existing.length > 0) {
        return null;
      }

      const token = generateToken();
      const expiresAt = now + ttlMs;

      this.sql.exec(
        "INSERT INTO locks (thread_id, token, expires_at) VALUES (?, ?, ?)",
        threadId,
        token,
        expiresAt,
      );

      return { threadId, token, expiresAt };
    });

    if (result) {
      this.scheduleCleanupIfNeeded();
    }

    return result;
  }

  releaseLock(threadId: string, token: string): void {
    this.sql.exec(
      "DELETE FROM locks WHERE thread_id = ? AND token = ?",
      threadId,
      token,
    );
  }

  forceReleaseLock(threadId: string): void {
    this.sql.exec("DELETE FROM locks WHERE thread_id = ?", threadId);
  }

  extendLock(threadId: string, token: string, ttlMs: number): boolean {
    return this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      const rows = this.sql
        .exec(
          `UPDATE locks SET expires_at = ?
           WHERE thread_id = ? AND token = ? AND expires_at > ?
           RETURNING thread_id`,
          now + ttlMs,
          threadId,
          token,
          now,
        )
        .toArray();
      return rows.length > 0;
    });
  }

  cacheGet(key: string): string | null {
    return this.readCacheValue(key, Date.now());
  }

  cacheSet(key: string, value: string, ttlMs?: number): void {
    const expiresAt = ttlMs ? Date.now() + ttlMs : null;
    this.upsertCacheValue(key, value, expiresAt);

    if (expiresAt != null) {
      this.scheduleCleanupIfNeeded();
    }
  }

  cacheSetIfNotExists(key: string, value: string, ttlMs?: number): boolean {
    const now = Date.now();
    const result = this.ctx.storage.transactionSync(() => {
      this.deleteExpiredCacheValue(key, now);

      const existing = this.readCacheValue(key, now);
      if (existing !== null) {
        return { inserted: false, expiresAt: null as number | null };
      }

      const expiresAt = ttlMs ? now + ttlMs : null;
      this.upsertCacheValue(key, value, expiresAt);
      return { inserted: true, expiresAt };
    });

    if (result.inserted && result.expiresAt != null) {
      this.scheduleCleanupIfNeeded();
    }
    return result.inserted;
  }

  cacheDelete(key: string): void {
    this.sql.exec("DELETE FROM cache WHERE key = ?", key);
  }

  listAppend(
    key: string,
    value: string,
    maxLength?: number,
    ttlMs?: number,
  ): void {
    const storageKey = this.listStorageKey(key);
    const result = this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      const list = this.readStringList(storageKey, now);
      list.push(value);

      if (maxLength !== undefined && maxLength > 0 && list.length > maxLength) {
        list.splice(0, list.length - maxLength);
      }

      const expiresAt = ttlMs ? now + ttlMs : null;
      this.upsertCacheValue(storageKey, JSON.stringify(list), expiresAt);
      return expiresAt;
    });

    if (result != null) {
      this.scheduleCleanupIfNeeded();
    }
  }

  listGet(key: string): string[] {
    return this.readStringList(this.listStorageKey(key), Date.now());
  }

  queueEnqueue(threadId: string, value: string, maxSize: number): number {
    const storageKey = this.queueStorageKey(threadId);
    const result = this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      const queue = this.readQueue(storageKey, now);

      if (queue.length >= maxSize) {
        queue.shift();
      }

      queue.push(value);
      const expiresAt = this.writeQueue(storageKey, queue, now);
      return { depth: queue.length, expiresAt };
    });

    if (result.expiresAt != null) {
      this.scheduleCleanupIfNeeded();
    }

    return result.depth;
  }

  queueDequeue(threadId: string): string | null {
    const storageKey = this.queueStorageKey(threadId);
    const result = this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      const queue = this.readQueue(storageKey, now);
      const next = queue.shift() ?? null;
      const expiresAt = this.writeQueue(storageKey, queue, now);
      return { next, expiresAt };
    });

    if (result.expiresAt != null) {
      this.scheduleCleanupIfNeeded();
    }

    return result.next;
  }

  queueDepth(threadId: string): number {
    const storageKey = this.queueStorageKey(threadId);

    return this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      const queue = this.readQueue(storageKey, now);
      this.writeQueue(storageKey, queue, now);
      return queue.length;
    });
  }

  async alarm(): Promise<void> {
    try {
      const now = Date.now();
      this.sql.exec("DELETE FROM locks WHERE expires_at <= ?", now);
      this.sql.exec(
        "DELETE FROM cache WHERE expires_at IS NOT NULL AND expires_at <= ?",
        now,
      );

      const next = this.nextExpiry();
      if (next != null) {
        await this.ctx.storage.setAlarm(next);
      }
    } catch (err) {
      console.error("ChatStateDO: alarm handler failed, rescheduling:", err);
      await this.ctx.storage.setAlarm(Date.now() + 30_000);
    }
  }

  private listStorageKey(key: string): string {
    return `${LIST_KEY_PREFIX}${key}`;
  }

  private queueStorageKey(threadId: string): string {
    return `${QUEUE_KEY_PREFIX}${threadId}`;
  }

  private readCacheValue(key: string, now: number): string | null {
    const rows = this.sql
      .exec<{
        value: string;
      }>(
        "SELECT value FROM cache WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)",
        key,
        now,
      )
      .toArray();

    return rows.length > 0 ? rows[0].value : null;
  }

  private deleteExpiredCacheValue(key: string, now: number): void {
    this.sql.exec(
      "DELETE FROM cache WHERE key = ? AND expires_at IS NOT NULL AND expires_at <= ?",
      key,
      now,
    );
  }

  private upsertCacheValue(
    key: string,
    value: string,
    expiresAt: number | null,
  ): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO cache (key, value, expires_at) VALUES (?, ?, ?)",
      key,
      value,
      expiresAt,
    );
  }

  private readStringList(key: string, now: number): string[] {
    this.deleteExpiredCacheValue(key, now);

    const rawValue = this.readCacheValue(key, now);
    if (rawValue === null) {
      return [];
    }

    try {
      const parsed = JSON.parse(rawValue) as unknown;
      return Array.isArray(parsed)
        ? parsed.filter((entry): entry is string => typeof entry === "string")
        : [];
    } catch {
      return [];
    }
  }

  private readQueue(key: string, now: number): string[] {
    return this.readStringList(key, now).filter((entry) =>
      this.isQueueEntryUnexpired(entry, now),
    );
  }

  private writeQueue(key: string, queue: string[], now: number): number | null {
    const expiresAt = this.maxQueueExpiry(queue, now);

    if (queue.length === 0 || expiresAt === null) {
      this.cacheDelete(key);
      return null;
    }

    this.upsertCacheValue(key, JSON.stringify(queue), expiresAt);
    return expiresAt;
  }

  private isQueueEntryUnexpired(value: string, now: number): boolean {
    try {
      const parsed = JSON.parse(value) as QueueRow;
      return typeof parsed.expiresAt === "number" && parsed.expiresAt > now;
    } catch {
      return false;
    }
  }

  private maxQueueExpiry(queue: string[], now: number): number | null {
    let maxExpiry: number | null = null;

    for (const entry of queue) {
      try {
        const parsed = JSON.parse(entry) as QueueRow;
        if (typeof parsed.expiresAt !== "number" || parsed.expiresAt <= now) {
          continue;
        }

        if (maxExpiry === null || parsed.expiresAt > maxExpiry) {
          maxExpiry = parsed.expiresAt;
        }
      } catch {
        continue;
      }
    }

    return maxExpiry;
  }

  private nextExpiry(): number | null {
    const now = Date.now();
    const rows = this.sql
      .exec<{ next_expiry: number | null }>(
        `SELECT MIN(expires_at) as next_expiry FROM (
          SELECT expires_at FROM locks WHERE expires_at > ?
          UNION ALL
          SELECT expires_at FROM cache WHERE expires_at IS NOT NULL AND expires_at > ?
        )`,
        now,
        now,
      )
      .toArray();
    return rows.length > 0 ? rows[0].next_expiry : null;
  }

  private scheduleCleanupIfNeeded(): void {
    const next = this.nextExpiry();
    if (next != null) {
      this.ctx.storage.setAlarm(next).catch((err: unknown) => {
        console.error("ChatStateDO: failed to schedule cleanup alarm:", err);
      });
    }
  }
}

function generateToken(): string {
  return crypto.randomUUID();
}
