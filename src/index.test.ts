/// <reference types="@cloudflare/workers-types" />
import type { Lock, StateAdapter } from "chat";
import { beforeEach, describe, expect, it } from "vitest";
import { CloudflareDOStateAdapter } from "./adapter";
import { createCloudflareState } from "./index";

// Use concrete adapter type so tests can call methods added in newer Chat SDK
// (e.g. setIfNotExists in 4.18) even when devDependency is an older version.
type AdapterUnderTest = CloudflareDOStateAdapter;

// ---------------------------------------------------------------------------
// Mock DO — mirrors ChatStateDO behavior using in-memory data structures.
// This lets us test the adapter's delegation logic, sharding, and
// serialization without requiring Cloudflare's DO runtime.
// ---------------------------------------------------------------------------

class MockChatStateDO {
  private readonly subscriptions = new Set<string>();
  private readonly locks = new Map<
    string,
    { token: string; expiresAt: number }
  >();
  private readonly cache = new Map<
    string,
    { value: string; expiresAt: number | null }
  >();
  private readonly queues = new Map<string, string[]>();
  private readonly lists = new Map<
    string,
    { values: string[]; expiresAt: number | null }
  >();

  subscribe(threadId: string): void {
    this.subscriptions.add(threadId);
  }

  unsubscribe(threadId: string): void {
    this.subscriptions.delete(threadId);
  }

  isSubscribed(threadId: string): boolean {
    return this.subscriptions.has(threadId);
  }

  acquireLock(
    threadId: string,
    ttlMs: number
  ): { threadId: string; token: string; expiresAt: number } | null {
    const now = Date.now();

    // Clean expired
    const existing = this.locks.get(threadId);
    if (existing && existing.expiresAt <= now) {
      this.locks.delete(threadId);
    }

    // Check if locked
    if (this.locks.has(threadId)) {
      return null;
    }

    const token = `mock_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const expiresAt = now + ttlMs;
    this.locks.set(threadId, { token, expiresAt });
    return { threadId, token, expiresAt };
  }

  releaseLock(threadId: string, token: string): void {
    const existing = this.locks.get(threadId);
    if (existing && existing.token === token) {
      this.locks.delete(threadId);
    }
  }

  extendLock(threadId: string, token: string, ttlMs: number): boolean {
    const now = Date.now();
    const existing = this.locks.get(threadId);
    if (!existing || existing.token !== token || existing.expiresAt <= now) {
      return false;
    }
    existing.expiresAt = now + ttlMs;
    return true;
  }

  cacheGet(key: string): string | null {
    const now = Date.now();
    const entry = this.cache.get(key);
    if (!entry) {
      return null;
    }
    if (entry.expiresAt !== null && entry.expiresAt <= now) {
      this.cache.delete(key);
      return null;
    }
    return entry.value;
  }

  cacheSet(key: string, value: string, ttlMs?: number): void {
    this.cache.set(key, {
      value,
      // Match DO behavior: falsy ttlMs (0, null, undefined) = no expiry
      expiresAt: ttlMs ? Date.now() + ttlMs : null,
    });
  }

  cacheSetIfNotExists(key: string, value: string, ttlMs?: number): boolean {
    if (this.cacheGet(key) !== null) {
      return false;
    }
    this.cacheSet(key, value, ttlMs);
    return true;
  }

  cacheDelete(key: string): void {
    this.cache.delete(key);
  }

  // -- Force release lock ---------------------------------------------------

  forceReleaseLock(threadId: string): void {
    this.locks.delete(threadId);
  }

  // -- Queue ----------------------------------------------------------------

  enqueue(threadId: string, value: string, maxSize: number): number {
    let queue = this.queues.get(threadId);
    if (!queue) {
      queue = [];
      this.queues.set(threadId, queue);
    }

    queue.push(value);

    // Trim to maxSize (keep newest)
    if (queue.length > maxSize) {
      queue.splice(0, queue.length - maxSize);
    }

    return queue.length;
  }

  dequeue(threadId: string): string | null {
    const queue = this.queues.get(threadId);
    if (!queue || queue.length === 0) {
      return null;
    }

    const now = Date.now();
    // Skip expired entries
    while (queue.length > 0) {
      const entry = JSON.parse(queue[0]) as { expiresAt: number };
      if (entry.expiresAt <= now) {
        queue.shift();
        continue;
      }
      const value = queue.shift()!;
      if (queue.length === 0) {
        this.queues.delete(threadId);
      }
      return value;
    }

    this.queues.delete(threadId);
    return null;
  }

  queueDepth(threadId: string): number {
    const queue = this.queues.get(threadId);
    if (!queue) return 0;
    const now = Date.now();
    return queue.filter((v) => {
      const entry = JSON.parse(v) as { expiresAt: number };
      return entry.expiresAt > now;
    }).length;
  }

  // -- Lists ----------------------------------------------------------------

  listAppend(
    key: string,
    value: string,
    maxLength?: number,
    ttlMs?: number
  ): void {
    const expiresAt = ttlMs ? Date.now() + ttlMs : null;
    let list = this.lists.get(key);

    // Check if expired
    if (list && list.expiresAt !== null && list.expiresAt <= Date.now()) {
      list = undefined;
    }

    if (!list) {
      list = { values: [], expiresAt };
      this.lists.set(key, list);
    }

    list.values.push(value);
    // Refresh TTL on every append
    if (expiresAt !== null) {
      list.expiresAt = expiresAt;
    }

    // Trim to maxLength (keep newest)
    if (maxLength != null && maxLength > 0 && list.values.length > maxLength) {
      list.values.splice(0, list.values.length - maxLength);
    }
  }

  listGet(key: string): string[] {
    const list = this.lists.get(key);
    if (!list) return [];

    if (list.expiresAt !== null && list.expiresAt <= Date.now()) {
      this.lists.delete(key);
      return [];
    }

    return [...list.values];
  }
}

// ---------------------------------------------------------------------------
// Mock DurableObjectNamespace — tracks which DO names are requested and
// returns the same MockChatStateDO for a given name.
// ---------------------------------------------------------------------------

function createMockNamespace() {
  const instances = new Map<string, MockChatStateDO>();
  const nameLog: string[] = [];
  const getOptionsLog: unknown[] = [];

  const namespace = {
    idFromName(name: string) {
      nameLog.push(name);
      return { name } as unknown as DurableObjectId;
    },
    get(id: DurableObjectId, options?: unknown) {
      getOptionsLog.push(options);
      const name = (id as unknown as { name: string }).name;
      if (!instances.has(name)) {
        instances.set(name, new MockChatStateDO());
      }
      const instance = instances.get(name);
      return instance as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;

  return { namespace, instances, nameLog, getOptionsLog };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CloudflareDOStateAdapter", () => {
  let adapter: AdapterUnderTest;
  let mock: ReturnType<typeof createMockNamespace>;

  beforeEach(async () => {
    mock = createMockNamespace();
    adapter = createCloudflareState({
      namespace: mock.namespace as any,
    });
    await adapter.connect();
  });

  // -- Connection ----------------------------------------------------------

  describe("connection", () => {
    it("should throw when not connected", async () => {
      const fresh = createCloudflareState({
        namespace: mock.namespace as any,
      });
      await expect(fresh.subscribe("test")).rejects.toThrow("not connected");
    });

    it("should connect successfully", async () => {
      const fresh = createCloudflareState({
        namespace: mock.namespace as any,
      });
      await fresh.connect();
      // Should not throw after connect
      await fresh.subscribe("test");
      expect(await fresh.isSubscribed("test")).toBe(true);
    });

    it("should handle double connect", async () => {
      await adapter.connect();
      // Should not throw
      await adapter.subscribe("test");
    });

    it("should disconnect", async () => {
      await adapter.disconnect();
      await expect(adapter.subscribe("test")).rejects.toThrow("not connected");
    });
  });

  // -- Subscriptions -------------------------------------------------------

  describe("subscriptions", () => {
    it("should subscribe to a thread", async () => {
      await adapter.subscribe("slack:C123:1234.5678");
      expect(await adapter.isSubscribed("slack:C123:1234.5678")).toBe(true);
    });

    it("should return false for unsubscribed thread", async () => {
      expect(await adapter.isSubscribed("slack:C123:1234.5678")).toBe(false);
    });

    it("should unsubscribe from a thread", async () => {
      await adapter.subscribe("slack:C123:1234.5678");
      await adapter.unsubscribe("slack:C123:1234.5678");
      expect(await adapter.isSubscribed("slack:C123:1234.5678")).toBe(false);
    });

    it("should handle duplicate subscribe", async () => {
      await adapter.subscribe("thread1");
      await adapter.subscribe("thread1");
      expect(await adapter.isSubscribed("thread1")).toBe(true);
    });

    it("should handle unsubscribe on non-existent thread", async () => {
      // Should not throw
      await adapter.unsubscribe("non-existent");
    });
  });

  // -- Locking -------------------------------------------------------------

  describe("locking", () => {
    it("should acquire a lock", async () => {
      const lock = await adapter.acquireLock("thread1", 5000);
      expect(lock).not.toBeNull();
      expect(lock?.threadId).toBe("thread1");
      expect(lock?.token).toBeTruthy();
    });

    it("should prevent double-locking", async () => {
      const lock1 = await adapter.acquireLock("thread1", 5000);
      const lock2 = await adapter.acquireLock("thread1", 5000);
      expect(lock1).not.toBeNull();
      expect(lock2).toBeNull();
    });

    it("should release a lock", async () => {
      const lock = await adapter.acquireLock("thread1", 5000);
      expect(lock).not.toBeNull();
      await adapter.releaseLock(lock as Lock);

      const lock2 = await adapter.acquireLock("thread1", 5000);
      expect(lock2).not.toBeNull();
    });

    it("should not release a lock with wrong token", async () => {
      const lock = await adapter.acquireLock("thread1", 5000);

      await adapter.releaseLock({
        threadId: "thread1",
        token: "fake-token",
        expiresAt: Date.now() + 5000,
      });

      // Original lock should still be held
      const lock2 = await adapter.acquireLock("thread1", 5000);
      expect(lock2).toBeNull();

      // Clean up
      await adapter.releaseLock(lock as Lock);
    });

    it("should allow re-locking after expiry", async () => {
      const lock1 = await adapter.acquireLock("thread1", 10); // 10ms TTL

      // Wait for expiry
      await new Promise((resolve) => setTimeout(resolve, 20));

      const lock2 = await adapter.acquireLock("thread1", 5000);
      expect(lock2).not.toBeNull();
      expect(lock2?.token).not.toBe(lock1?.token);
    });

    it("should extend a lock", async () => {
      const lock = await adapter.acquireLock("thread1", 100);
      expect(lock).not.toBeNull();

      const extended = await adapter.extendLock(lock as Lock, 5000);
      expect(extended).toBe(true);

      // Should still be locked
      const lock2 = await adapter.acquireLock("thread1", 5000);
      expect(lock2).toBeNull();
    });

    it("should not extend an expired lock", async () => {
      const lock = await adapter.acquireLock("thread1", 10);
      expect(lock).not.toBeNull();

      await new Promise((resolve) => setTimeout(resolve, 20));

      const extended = await adapter.extendLock(lock as Lock, 5000);
      expect(extended).toBe(false);
    });

    it("should not extend a lock with wrong token", async () => {
      await adapter.acquireLock("thread1", 5000);

      const extended = await adapter.extendLock(
        { threadId: "thread1", token: "wrong", expiresAt: Date.now() + 5000 },
        5000
      );
      expect(extended).toBe(false);
    });
  });

  // -- Cache ---------------------------------------------------------------

  describe("cache", () => {
    it("should set and get a value", async () => {
      await adapter.set("key1", { hello: "world" });
      const value = await adapter.get("key1");
      expect(value).toEqual({ hello: "world" });
    });

    it("should return null for missing key", async () => {
      expect(await adapter.get("missing")).toBeNull();
    });

    it("should delete a value", async () => {
      await adapter.set("key1", "value1");
      await adapter.delete("key1");
      expect(await adapter.get("key1")).toBeNull();
    });

    it("should handle delete on non-existent key", async () => {
      // Should not throw
      await adapter.delete("non-existent");
    });

    it("should overwrite existing value", async () => {
      await adapter.set("key1", "first");
      await adapter.set("key1", "second");
      expect(await adapter.get("key1")).toBe("second");
    });

    it("should handle various JSON types", async () => {
      await adapter.set("string", "hello");
      await adapter.set("number", 42);
      await adapter.set("boolean", true);
      await adapter.set("array", [1, 2, 3]);

      expect(await adapter.get("string")).toBe("hello");
      expect(await adapter.get("number")).toBe(42);
      expect(await adapter.get("boolean")).toBe(true);
      expect(await adapter.get("array")).toEqual([1, 2, 3]);
    });

    it("should treat null values as indistinguishable from cache miss", async () => {
      // Storing null serializes to "null" string; JSON.parse("null") → null,
      // which is the same as the "key not found" return value. This matches
      // the Redis adapter behavior and is a known SDK-wide convention.
      await adapter.set("null-key", null);
      expect(await adapter.get("null-key")).toBeNull();
    });

    it("should respect TTL", async () => {
      await adapter.set("expiring", "value", 10); // 10ms TTL

      // Should be available immediately
      expect(await adapter.get("expiring")).toBe("value");

      // Wait for expiry
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(await adapter.get("expiring")).toBeNull();
    });

    it("should persist values without TTL", async () => {
      await adapter.set("persistent", "value");

      // Wait a bit
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(await adapter.get("persistent")).toBe("value");
    });

    it("should treat ttlMs of 0 as no expiry (matches Redis behavior)", async () => {
      await adapter.set("zero-ttl", "value", 0);

      // Wait a bit — should still be available
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(await adapter.get("zero-ttl")).toBe("value");
    });

    it("should setIfNotExists only when key is missing or expired", async () => {
      const set1 = await adapter.setIfNotExists("nx-key", "first");
      expect(set1).toBe(true);
      expect(await adapter.get("nx-key")).toBe("first");

      const set2 = await adapter.setIfNotExists("nx-key", "second");
      expect(set2).toBe(false);
      expect(await adapter.get("nx-key")).toBe("first");

      await adapter.set("expiring-nx", "old", 10);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const set3 = await adapter.setIfNotExists("expiring-nx", "new");
      expect(set3).toBe(true);
      expect(await adapter.get("expiring-nx")).toBe("new");
    });
  });

  // -- Force Release Lock ---------------------------------------------------

  describe("forceReleaseLock", () => {
    it("should release a lock without knowing the token", async () => {
      const lock = await adapter.acquireLock("thread1", 5000);
      expect(lock).not.toBeNull();

      await adapter.forceReleaseLock("thread1");

      // Should be able to re-acquire
      const lock2 = await adapter.acquireLock("thread1", 5000);
      expect(lock2).not.toBeNull();
    });

    it("should not throw when no lock exists", async () => {
      await adapter.forceReleaseLock("non-existent");
    });

    it("should allow re-acquiring after force release", async () => {
      await adapter.acquireLock("thread1", 5000);
      await adapter.forceReleaseLock("thread1");

      const lock = await adapter.acquireLock("thread1", 5000);
      expect(lock).not.toBeNull();
      expect(lock?.threadId).toBe("thread1");
    });
  });

  // -- Queue ---------------------------------------------------------------

  describe("queue operations", () => {
    const makeEntry = (id: number, ttlMs = 60_000) => ({
      enqueuedAt: Date.now(),
      expiresAt: Date.now() + ttlMs,
      message: { id } as any,
    });

    it("should enqueue and return depth", async () => {
      const depth = await adapter.enqueue("thread1", makeEntry(1), 10);
      expect(depth).toBe(1);
    });

    it("should enqueue multiple and return correct depth", async () => {
      await adapter.enqueue("thread1", makeEntry(1), 10);
      const depth = await adapter.enqueue("thread1", makeEntry(2), 10);
      expect(depth).toBe(2);
    });

    it("should trim to maxSize keeping newest", async () => {
      await adapter.enqueue("thread1", makeEntry(1), 2);
      await adapter.enqueue("thread1", makeEntry(2), 2);
      const depth = await adapter.enqueue("thread1", makeEntry(3), 2);
      expect(depth).toBe(2);

      // Oldest (1) should be gone, dequeue should return 2
      const entry = await adapter.dequeue("thread1");
      expect(entry?.message).toEqual({ id: 2 });
    });

    it("should dequeue in FIFO order", async () => {
      await adapter.enqueue("thread1", makeEntry(1), 10);
      await adapter.enqueue("thread1", makeEntry(2), 10);
      await adapter.enqueue("thread1", makeEntry(3), 10);

      const e1 = await adapter.dequeue("thread1");
      const e2 = await adapter.dequeue("thread1");
      const e3 = await adapter.dequeue("thread1");

      expect(e1?.message).toEqual({ id: 1 });
      expect(e2?.message).toEqual({ id: 2 });
      expect(e3?.message).toEqual({ id: 3 });
    });

    it("should return null when queue is empty", async () => {
      const entry = await adapter.dequeue("thread1");
      expect(entry).toBeNull();
    });

    it("should skip expired entries on dequeue", async () => {
      await adapter.enqueue("thread1", makeEntry(1, 10), 10); // expires in 10ms
      await adapter.enqueue("thread1", makeEntry(2, 60_000), 10);

      await new Promise((resolve) => setTimeout(resolve, 20));

      const entry = await adapter.dequeue("thread1");
      expect(entry?.message).toEqual({ id: 2 });
    });

    it("should return 0 depth for empty queue", async () => {
      const depth = await adapter.queueDepth("thread1");
      expect(depth).toBe(0);
    });

    it("should not count expired entries in depth", async () => {
      await adapter.enqueue("thread1", makeEntry(1, 10), 10);
      await adapter.enqueue("thread1", makeEntry(2, 60_000), 10);

      await new Promise((resolve) => setTimeout(resolve, 20));

      const depth = await adapter.queueDepth("thread1");
      expect(depth).toBe(1);
    });

    it("should isolate queues across threads", async () => {
      await adapter.enqueue("thread1", makeEntry(1), 10);
      await adapter.enqueue("thread2", makeEntry(2), 10);

      expect(await adapter.queueDepth("thread1")).toBe(1);
      expect(await adapter.queueDepth("thread2")).toBe(1);

      const e1 = await adapter.dequeue("thread1");
      expect(e1?.message).toEqual({ id: 1 });
    });
  });

  // -- Lists ---------------------------------------------------------------

  describe("list operations", () => {
    it("should append and get values in order", async () => {
      await adapter.appendToList("list1", "a");
      await adapter.appendToList("list1", "b");
      await adapter.appendToList("list1", "c");

      const values = await adapter.getList("list1");
      expect(values).toEqual(["a", "b", "c"]);
    });

    it("should return empty array for non-existent key", async () => {
      const values = await adapter.getList("missing");
      expect(values).toEqual([]);
    });

    it("should trim to maxLength keeping newest", async () => {
      await adapter.appendToList("list1", "a", { maxLength: 2 });
      await adapter.appendToList("list1", "b", { maxLength: 2 });
      await adapter.appendToList("list1", "c", { maxLength: 2 });

      const values = await adapter.getList("list1");
      expect(values).toEqual(["b", "c"]);
    });

    it("should expire after TTL", async () => {
      await adapter.appendToList("list1", "a", { ttlMs: 10 });

      expect(await adapter.getList("list1")).toEqual(["a"]);

      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(await adapter.getList("list1")).toEqual([]);
    });

    it("should handle various value types", async () => {
      await adapter.appendToList("list1", { key: "value" });
      await adapter.appendToList("list1", 42);
      await adapter.appendToList("list1", "string");

      const values = await adapter.getList("list1");
      expect(values).toEqual([{ key: "value" }, 42, "string"]);
    });

    it("should route lists to default shard regardless of shardKey", async () => {
      const shardedMock = createMockNamespace();
      const sharded = createCloudflareState({
        namespace: shardedMock.namespace as any,
        name: "default-shard",
        shardKey: (threadId) => threadId.split(":")[0],
      });
      await sharded.connect();

      await sharded.appendToList("my-list", "value");
      await sharded.getList("my-list");

      // List calls should go to the named default shard
      expect(shardedMock.nameLog).toEqual(["default-shard", "default-shard"]);
    });
  });

  // -- Sharding ------------------------------------------------------------

  describe("sharding", () => {
    it("should route to default shard without shardKey", async () => {
      await adapter.subscribe("slack:C123:thread1");
      await adapter.subscribe("discord:456:thread2");

      // Both should go to the "default" DO instance
      expect(mock.nameLog).toEqual(["default", "default"]);
    });

    it("should route to different shards with shardKey", async () => {
      const shardedMock = createMockNamespace();
      const sharded = createCloudflareState({
        namespace: shardedMock.namespace as any,
        shardKey: (threadId) => threadId.split(":")[0],
      });
      await sharded.connect();

      await sharded.subscribe("slack:C123:thread1");
      await sharded.subscribe("discord:456:thread2");
      await sharded.subscribe("slack:C789:thread3");

      expect(shardedMock.nameLog).toEqual(["slack", "discord", "slack"]);
    });

    it("should isolate subscriptions across shards", async () => {
      const shardedMock = createMockNamespace();
      const sharded = createCloudflareState({
        namespace: shardedMock.namespace as any,
        shardKey: (threadId) => threadId.split(":")[0],
      });
      await sharded.connect();

      await sharded.subscribe("slack:C123:thread1");

      // Different shard should not see the subscription
      // (In real DOs these are entirely separate instances)
      expect(shardedMock.instances.size).toBe(1);
      expect(shardedMock.instances.has("slack")).toBe(true);
    });

    it("should forward locationHint to namespace.get()", async () => {
      const hintMock = createMockNamespace();
      const hinted = createCloudflareState({
        namespace: hintMock.namespace as any,
        locationHint: "enam" as any,
      });
      await hinted.connect();

      await hinted.subscribe("thread1");

      expect(hintMock.getOptionsLog[0]).toEqual({ locationHint: "enam" });
    });

    it("should not pass locationHint when not configured", async () => {
      await adapter.subscribe("thread1");

      // get() is called without options when no locationHint is set
      expect(mock.getOptionsLog[0]).toBeUndefined();
    });

    it("should route cache to default shard regardless of shardKey", async () => {
      const shardedMock = createMockNamespace();
      const sharded = createCloudflareState({
        namespace: shardedMock.namespace as any,
        name: "cache-shard",
        shardKey: (threadId) => threadId.split(":")[0],
      });
      await sharded.connect();

      await sharded.set("some-key", "some-value");
      await sharded.get("some-key");

      // Cache calls should go to the named default shard, not a thread shard
      expect(shardedMock.nameLog).toEqual(["cache-shard", "cache-shard"]);
    });
  });

  // -- Exports -------------------------------------------------------------

  describe("exports", () => {
    it("should export createCloudflareState function", () => {
      expect(typeof createCloudflareState).toBe("function");
    });

    it("should create an adapter instance", () => {
      const inst = createCloudflareState({
        namespace: mock.namespace as any,
      });
      expect(inst).toBeInstanceOf(CloudflareDOStateAdapter);
    });
  });
});


