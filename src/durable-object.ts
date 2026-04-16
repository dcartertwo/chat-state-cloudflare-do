import { DurableObject } from "cloudflare:workers";

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
// The TEnv generic is required by the DurableObject base class but unused
// here — ChatStateDO doesn't access env bindings. Defaults to unknown so
// consumers don't need to specify it. Named TEnv (not Env) to avoid
// shadowing the common worker Env interface.
export class ChatStateDO<TEnv = unknown> extends DurableObject<TEnv> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: TEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;

    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
    });
  }

  // -- Schema migration ----------------------------------------------------

  private migrate(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS _schema_version (
        version INTEGER PRIMARY KEY
      );
    `);

    const row = this.sql
      .exec<{ version: number }>(
        "SELECT COALESCE(MAX(version), 0) as version FROM _schema_version"
      )
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

    if (row.version < 2) {
      this.sql.exec(`
        CREATE TABLE queue (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          thread_id   TEXT NOT NULL,
          value       TEXT NOT NULL,
          enqueued_at INTEGER NOT NULL,
          expires_at  INTEGER NOT NULL
        );

        CREATE INDEX idx_queue_thread ON queue(thread_id, id);
        CREATE INDEX idx_queue_expires ON queue(expires_at);

        CREATE TABLE lists (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          key        TEXT NOT NULL,
          value      TEXT NOT NULL,
          expires_at INTEGER
        );

        CREATE INDEX idx_lists_key ON lists(key, id);
        CREATE INDEX idx_lists_expires ON lists(expires_at)
          WHERE expires_at IS NOT NULL;

        INSERT INTO _schema_version (version) VALUES (2);
      `);
    }
  }

  // -- Subscriptions -------------------------------------------------------

  subscribe(threadId: string): void {
    this.sql.exec(
      "INSERT OR IGNORE INTO subscriptions (thread_id) VALUES (?)",
      threadId
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
          threadId
        )
        .toArray().length > 0
    );
  }

  // -- Locking -------------------------------------------------------------
  // Wrapped in transactionSync() for explicit atomicity.
  // DOs are single-threaded, but transactionSync makes the guarantee
  // obvious and costs nothing.

  acquireLock(
    threadId: string,
    ttlMs: number
  ): { threadId: string; token: string; expiresAt: number } | null {
    const result = this.ctx.storage.transactionSync(() => {
      const now = Date.now();

      // Remove expired lock for this thread
      this.sql.exec(
        "DELETE FROM locks WHERE thread_id = ? AND expires_at <= ?",
        threadId,
        now
      );

      // Check if still locked
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
        expiresAt
      );

      return { threadId, token, expiresAt };
    });

    // Schedule alarm outside the transaction — setAlarm is async/fire-and-forget
    // and should not be inside transactionSync.
    if (result) {
      this.scheduleCleanupIfNeeded();
    }

    return result;
  }

  releaseLock(threadId: string, token: string): void {
    this.sql.exec(
      "DELETE FROM locks WHERE thread_id = ? AND token = ?",
      threadId,
      token
    );
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
          now
        )
        .toArray();
      return rows.length > 0;
    });
  }

  forceReleaseLock(threadId: string): void {
    this.sql.exec("DELETE FROM locks WHERE thread_id = ?", threadId);
  }

  // -- Queue ---------------------------------------------------------------
  // Thread-scoped FIFO queue for concurrency strategies (queue, debounce).

  enqueue(threadId: string, value: string, maxSize: number): number {
    const parsed = JSON.parse(value) as { enqueuedAt: number; expiresAt: number };

    const result = this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        "INSERT INTO queue (thread_id, value, enqueued_at, expires_at) VALUES (?, ?, ?, ?)",
        threadId,
        value,
        parsed.enqueuedAt,
        parsed.expiresAt
      );

      // Trim: keep only the newest maxSize entries (highest id values)
      this.sql.exec(
        `DELETE FROM queue WHERE thread_id = ? AND id NOT IN (
          SELECT id FROM queue WHERE thread_id = ? ORDER BY id DESC LIMIT ?
        )`,
        threadId,
        threadId,
        maxSize
      );

      const row = this.sql
        .exec<{ cnt: number }>(
          "SELECT COUNT(*) as cnt FROM queue WHERE thread_id = ?",
          threadId
        )
        .one();
      return row.cnt;
    });

    this.scheduleCleanupIfNeeded();
    return result;
  }

  dequeue(threadId: string): string | null {
    return this.ctx.storage.transactionSync(() => {
      const now = Date.now();

      // Remove expired entries first
      this.sql.exec(
        "DELETE FROM queue WHERE thread_id = ? AND expires_at <= ?",
        threadId,
        now
      );

      // Pop the oldest remaining entry (lowest id = FIFO)
      const rows = this.sql
        .exec<{ id: number; value: string }>(
          "SELECT id, value FROM queue WHERE thread_id = ? ORDER BY id ASC LIMIT 1",
          threadId
        )
        .toArray();

      if (rows.length === 0) {
        return null;
      }

      this.sql.exec("DELETE FROM queue WHERE id = ?", rows[0].id);
      return rows[0].value;
    });
  }

  queueDepth(threadId: string): number {
    const row = this.sql
      .exec<{ cnt: number }>(
        "SELECT COUNT(*) as cnt FROM queue WHERE thread_id = ? AND expires_at > ?",
        threadId,
        Date.now()
      )
      .one();
    return row.cnt;
  }

  // -- Lists ---------------------------------------------------------------
  // Key-scoped ordered lists (not thread-scoped). Used for message history.

  listAppend(
    key: string,
    value: string,
    maxLength?: number,
    ttlMs?: number
  ): void {
    const expiresAt = ttlMs ? Date.now() + ttlMs : null;

    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        "INSERT INTO lists (key, value, expires_at) VALUES (?, ?, ?)",
        key,
        value,
        expiresAt
      );

      // Refresh TTL on ALL entries for this key (matches Redis PEXPIRE behavior)
      if (expiresAt !== null) {
        this.sql.exec(
          "UPDATE lists SET expires_at = ? WHERE key = ?",
          expiresAt,
          key
        );
      }

      // Trim to maxLength: keep only the newest entries (highest id)
      if (maxLength != null && maxLength > 0) {
        this.sql.exec(
          `DELETE FROM lists WHERE key = ? AND id NOT IN (
            SELECT id FROM lists WHERE key = ? ORDER BY id DESC LIMIT ?
          )`,
          key,
          key,
          maxLength
        );
      }
    });

    if (expiresAt !== null) {
      this.scheduleCleanupIfNeeded();
    }
  }

  listGet(key: string): string[] {
    const now = Date.now();

    // Clean expired entries first
    this.sql.exec(
      "DELETE FROM lists WHERE key = ? AND expires_at IS NOT NULL AND expires_at <= ?",
      key,
      now
    );

    const rows = this.sql
      .exec<{ value: string }>(
        "SELECT value FROM lists WHERE key = ? ORDER BY id ASC",
        key
      )
      .toArray();
    return rows.map((r) => r.value);
  }

  // -- Cache ---------------------------------------------------------------

  cacheGet(key: string): string | null {
    const now = Date.now();
    const rows = this.sql
      .exec<{ value: string }>(
        "SELECT value FROM cache WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)",
        key,
        now
      )
      .toArray();
    return rows.length > 0 ? rows[0].value : null;
  }

  cacheSet(key: string, value: string, ttlMs?: number): void {
    // ttlMs of 0, null, or undefined means "no expiry" — matches Redis adapter
    // behavior where falsy ttlMs persists the entry forever.
    const expiresAt = ttlMs ? Date.now() + ttlMs : null;
    this.sql.exec(
      "INSERT OR REPLACE INTO cache (key, value, expires_at) VALUES (?, ?, ?)",
      key,
      value,
      expiresAt
    );
    // Only schedule alarm when we actually added an expiring entry —
    // avoids a wasted nextExpiry() SQL scan on permanent cache writes.
    if (expiresAt != null) {
      this.scheduleCleanupIfNeeded();
    }
  }

  /**
   * Set the key only if it does not exist (or is expired). Returns true if
   * the value was set, false if the key already existed and is not expired.
   */
  cacheSetIfNotExists(key: string, value: string, ttlMs?: number): boolean {
    const now = Date.now();
    const result = this.ctx.storage.transactionSync(() => {
      const existing = this.sql
        .exec(
          "SELECT 1 FROM cache WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)",
          key,
          now
        )
        .toArray();
      if (existing.length > 0) {
        return { inserted: false, expiresAt: null as number | null };
      }
      // Remove any expired row that's still physically present —
      // without this, the INSERT below would hit a PRIMARY KEY violation.
      this.sql.exec(
        "DELETE FROM cache WHERE key = ? AND expires_at IS NOT NULL AND expires_at <= ?",
        key,
        now
      );
      const expiresAt = ttlMs ? Date.now() + ttlMs : null;
      this.sql.exec(
        "INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?)",
        key,
        value,
        expiresAt
      );
      return { inserted: true, expiresAt };
    });

    // Schedule alarm outside the transaction — same pattern as acquireLock().
    if (result.inserted && result.expiresAt != null) {
      this.scheduleCleanupIfNeeded();
    }
    return result.inserted;
  }

  cacheDelete(key: string): void {
    this.sql.exec("DELETE FROM cache WHERE key = ?", key);
  }

  // -- Alarm (TTL cleanup) -------------------------------------------------

  // CF docs recommend catching exceptions in alarm handlers to prevent
  // retry exhaustion (alarms only retry up to 6 times with exponential
  // backoff). On failure we reschedule 30s out so cleanup eventually
  // completes even after transient errors.
  // https://developers.cloudflare.com/durable-objects/api/alarms/
  async alarm(): Promise<void> {
    try {
      const now = Date.now();
      this.sql.exec("DELETE FROM locks WHERE expires_at <= ?", now);
      this.sql.exec(
        "DELETE FROM cache WHERE expires_at IS NOT NULL AND expires_at <= ?",
        now
      );
      this.sql.exec("DELETE FROM queue WHERE expires_at <= ?", now);
      this.sql.exec(
        "DELETE FROM lists WHERE expires_at IS NOT NULL AND expires_at <= ?",
        now
      );

      // Reschedule for the next expiring entry
      const next = this.nextExpiry();
      if (next != null) {
        await this.ctx.storage.setAlarm(next);
      }
    } catch (err) {
      console.error("ChatStateDO: alarm handler failed, rescheduling:", err);
      // Reschedule in 30 seconds so cleanup retries even if we've
      // exhausted the automatic alarm retry budget.
      await this.ctx.storage.setAlarm(Date.now() + 30_000);
    }
  }

  /**
   * Find the earliest future expiration timestamp across all tables.
   * Filters out already-expired rows to avoid scheduling unnecessary
   * immediate alarms.
   */
  private nextExpiry(): number | null {
    const now = Date.now();
    const rows = this.sql
      .exec<{ next_expiry: number | null }>(
        `SELECT MIN(expires_at) as next_expiry FROM (
          SELECT expires_at FROM locks WHERE expires_at > ?
          UNION ALL
          SELECT expires_at FROM cache WHERE expires_at IS NOT NULL AND expires_at > ?
          UNION ALL
          SELECT expires_at FROM queue WHERE expires_at > ?
          UNION ALL
          SELECT expires_at FROM lists WHERE expires_at IS NOT NULL AND expires_at > ?
        )`,
        now,
        now,
        now,
        now
      )
      .toArray();
    return rows.length > 0 ? rows[0].next_expiry : null;
  }

  private scheduleCleanupIfNeeded(): void {
    const next = this.nextExpiry();
    if (next != null) {
      // setAlarm is async but we intentionally fire-and-forget —
      // CF auto-coalesces writes and flushes them atomically.
      this.ctx.storage.setAlarm(next).catch((err: unknown) => {
        console.error("ChatStateDO: failed to schedule cleanup alarm:", err);
      });
    }
  }
}

function generateToken(): string {
  return crypto.randomUUID();
}
