import type { Lock, StateAdapter } from "chat";
import type { ChatStateDO } from "./durable-object";
import type { CloudflareStateOptions } from "./types";

/**
 * Chat SDK state adapter backed by Cloudflare Durable Objects.
 *
 * Provides persistent subscriptions, distributed locking (via DO
 * single-threaded atomicity), and key-value caching with SQLite storage.
 *
 * Each method call creates a fresh DO stub. Stubs are cheap (just a
 * JS object) and the Cloudflare docs recommend against reusing stubs
 * after exceptions.
 */
export class CloudflareDOStateAdapter implements StateAdapter {
  private readonly namespace: DurableObjectNamespace<ChatStateDO>;
  private readonly defaultName: string;
  private readonly shardKey?: (threadId: string) => string;
  private readonly locationHint?: DurableObjectLocationHint;
  private connected = false;

  constructor(options: CloudflareStateOptions) {
    if (!options.namespace) {
      throw new Error(
        "CloudflareDOStateAdapter: namespace binding is required. " +
          "Ensure the DurableObjectNamespace is bound in your wrangler configuration."
      );
    }
    this.namespace = options.namespace;
    this.defaultName = options.name ?? "default";
    this.shardKey = options.shardKey;
    this.locationHint = options.locationHint;
  }

  /**
   * Get a stub for the DO instance that owns the given thread.
   * Creates a fresh stub every time to avoid broken-stub issues.
   */
  private stub(threadId?: string): DurableObjectStub<ChatStateDO> {
    this.ensureConnected();
    const name =
      threadId && this.shardKey ? this.shardKey(threadId) : this.defaultName;
    const id = this.namespace.idFromName(name);
    return this.locationHint
      ? this.namespace.get(id, { locationHint: this.locationHint })
      : this.namespace.get(id);
  }

  private ensureConnected(): void {
    if (!this.connected) {
      throw new Error(
        "CloudflareDOStateAdapter is not connected. Call connect() first."
      );
    }
  }

  // -- Lifecycle -----------------------------------------------------------

  async connect(): Promise<void> {
    this.connected = true;
  }

  // Intentionally minimal: Durable Object state is persistent and there is
  // no connection to tear down (unlike Redis). We only flip the boolean so
  // that subsequent calls throw until connect() is called again.
  async disconnect(): Promise<void> {
    this.connected = false;
  }

  // -- Subscriptions -------------------------------------------------------

  async subscribe(threadId: string): Promise<void> {
    await this.stub(threadId).subscribe(threadId);
  }

  async unsubscribe(threadId: string): Promise<void> {
    await this.stub(threadId).unsubscribe(threadId);
  }

  async isSubscribed(threadId: string): Promise<boolean> {
    return this.stub(threadId).isSubscribed(threadId);
  }

  // -- Locking -------------------------------------------------------------

  async acquireLock(threadId: string, ttlMs: number): Promise<Lock | null> {
    return this.stub(threadId).acquireLock(threadId, ttlMs);
  }

  async releaseLock(lock: Lock): Promise<void> {
    await this.stub(lock.threadId).releaseLock(lock.threadId, lock.token);
  }

  async extendLock(lock: Lock, ttlMs: number): Promise<boolean> {
    return this.stub(lock.threadId).extendLock(
      lock.threadId,
      lock.token,
      ttlMs
    );
  }

  // -- Cache ---------------------------------------------------------------
  // Cache keys are not thread-scoped, so they always route to the
  // default shard regardless of the shardKey configuration.
  //
  // Note: storing `null` via set() serializes to the string "null", so
  // get() will return `null` — indistinguishable from a cache miss. This
  // matches the behavior of the Redis state adapter. Callers should avoid
  // storing `null` values if they need to distinguish "exists as null"
  // from "not found".

  async get<T = unknown>(key: string): Promise<T | null> {
    const raw = await this.stub().cacheGet(key);
    if (raw === null) {
      return null;
    }
    try {
      return JSON.parse(raw) as T;
    } catch {
      // Defensive: set() always JSON.stringify's, so parse should never
      // fail through the public API. This handles values written directly
      // to the DO's cache table outside of the adapter.
      return raw as unknown as T;
    }
  }

  async set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void> {
    await this.stub().cacheSet(key, JSON.stringify(value), ttlMs);
  }

  async delete(key: string): Promise<void> {
    await this.stub().cacheDelete(key);
  }
}
