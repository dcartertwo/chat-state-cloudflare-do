import type { Lock, QueueEntry, StateAdapter } from "chat";
import type { ChatStateDO } from "./durable-object";
import type { CloudflareStateOptions } from "./types";

function parseStoredJson<T>(raw: string, label: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(
      `CloudflareDOStateAdapter: expected JSON-encoded ${label}`,
      { cause: error },
    );
  }
}

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
          "Ensure the DurableObjectNamespace is bound in your wrangler configuration.",
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
        "CloudflareDOStateAdapter is not connected. Call connect() first.",
      );
    }
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async subscribe(threadId: string): Promise<void> {
    await this.stub(threadId).subscribe(threadId);
  }

  async unsubscribe(threadId: string): Promise<void> {
    await this.stub(threadId).unsubscribe(threadId);
  }

  async isSubscribed(threadId: string): Promise<boolean> {
    return this.stub(threadId).isSubscribed(threadId);
  }

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
      ttlMs,
    );
  }

  async forceReleaseLock(threadId: string): Promise<void> {
    await this.stub(threadId).forceReleaseLock(threadId);
  }

  async appendToList(
    key: string,
    value: unknown,
    options?: { maxLength?: number; ttlMs?: number },
  ): Promise<void> {
    await this.stub().listAppend(
      key,
      JSON.stringify(value),
      options?.maxLength,
      options?.ttlMs,
    );
  }

  async getList<T = unknown>(key: string): Promise<T[]> {
    const rawValues = await this.stub().listGet(key);
    return rawValues.map((rawValue) =>
      parseStoredJson<T>(rawValue, `list entry for key "${key}"`),
    );
  }

  async enqueue(
    threadId: string,
    entry: QueueEntry,
    maxSize: number,
  ): Promise<number> {
    return this.stub(threadId).queueEnqueue(
      threadId,
      JSON.stringify(entry),
      maxSize,
    );
  }

  async dequeue(threadId: string): Promise<QueueEntry | null> {
    const rawValue = await this.stub(threadId).queueDequeue(threadId);
    return rawValue === null
      ? null
      : parseStoredJson<QueueEntry>(
          rawValue,
          `queue entry for thread "${threadId}"`,
        );
  }

  async queueDepth(threadId: string): Promise<number> {
    return this.stub(threadId).queueDepth(threadId);
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    const raw = await this.stub().cacheGet(key);
    if (raw === null) {
      return null;
    }

    return parseStoredJson<T>(raw, `cache value for key "${key}"`);
  }

  async set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void> {
    await this.stub().cacheSet(key, JSON.stringify(value), ttlMs);
  }

  async setIfNotExists<T = unknown>(
    key: string,
    value: T,
    ttlMs?: number,
  ): Promise<boolean> {
    return this.stub().cacheSetIfNotExists(key, JSON.stringify(value), ttlMs);
  }

  async delete(key: string): Promise<void> {
    await this.stub().cacheDelete(key);
  }
}
