/// <reference types="@cloudflare/workers-types" />
import type { Lock, QueueEntry } from "chat";
import { beforeEach, describe, expect, it } from "vitest";
import { CloudflareDOStateAdapter } from "./adapter";
import { createCloudflareState } from "./index";

type AdapterUnderTest = CloudflareDOStateAdapter;

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
  private readonly lists = new Map<
    string,
    { values: string[]; expiresAt: number | null }
  >();
  private readonly queues = new Map<string, string[]>();

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
    ttlMs: number,
  ): { threadId: string; token: string; expiresAt: number } | null {
    const now = Date.now();
    const existing = this.locks.get(threadId);

    if (existing && existing.expiresAt <= now) {
      this.locks.delete(threadId);
    }

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

  forceReleaseLock(threadId: string): void {
    this.locks.delete(threadId);
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

  listAppend(
    key: string,
    value: string,
    maxLength?: number,
    ttlMs?: number,
  ): void {
    const now = Date.now();
    const existing = this.lists.get(key);

    if (existing && existing.expiresAt !== null && existing.expiresAt <= now) {
      this.lists.delete(key);
    }

    const nextValues = [...(this.lists.get(key)?.values ?? []), value];

    if (
      maxLength !== undefined &&
      maxLength > 0 &&
      nextValues.length > maxLength
    ) {
      nextValues.splice(0, nextValues.length - maxLength);
    }

    this.lists.set(key, {
      values: nextValues,
      expiresAt: ttlMs ? now + ttlMs : null,
    });
  }

  listGet(key: string): string[] {
    const now = Date.now();
    const entry = this.lists.get(key);
    if (!entry) {
      return [];
    }
    if (entry.expiresAt !== null && entry.expiresAt <= now) {
      this.lists.delete(key);
      return [];
    }
    return [...entry.values];
  }

  queueEnqueue(threadId: string, value: string, maxSize: number): number {
    const now = Date.now();
    const queue = (this.queues.get(threadId) ?? []).filter((entry) =>
      isQueueEntryUnexpired(entry, now),
    );

    if (queue.length >= maxSize) {
      queue.shift();
    }

    queue.push(value);
    this.queues.set(threadId, queue);
    return queue.length;
  }

  queueDequeue(threadId: string): string | null {
    const now = Date.now();
    const queue = (this.queues.get(threadId) ?? []).filter((entry) =>
      isQueueEntryUnexpired(entry, now),
    );
    const next = queue.shift() ?? null;

    if (queue.length === 0) {
      this.queues.delete(threadId);
    } else {
      this.queues.set(threadId, queue);
    }

    return next;
  }

  queueDepth(threadId: string): number {
    const now = Date.now();
    const queue = (this.queues.get(threadId) ?? []).filter((entry) =>
      isQueueEntryUnexpired(entry, now),
    );

    if (queue.length === 0) {
      this.queues.delete(threadId);
    } else {
      this.queues.set(threadId, queue);
    }

    return queue.length;
  }
}

function isQueueEntryUnexpired(raw: string, now: number): boolean {
  const parsed = JSON.parse(raw) as QueueEntry;
  return parsed.expiresAt > now;
}

function createMockNamespace() {
  const instances = new Map<string, MockChatStateDO>();
  const nameLog: string[] = [];
  const getOptionsLog: unknown[] = [];

  const namespace = {
    idFromName(name: string) {
      nameLog.push(name);
      return { name } as DurableObjectId & { name: string };
    },
    get(id: DurableObjectId, options?: unknown) {
      getOptionsLog.push(options);
      const { name } = id as DurableObjectId & { name: string };
      if (!instances.has(name)) {
        instances.set(name, new MockChatStateDO());
      }
      return instances.get(name) as unknown as DurableObjectStub;
    },
  } as DurableObjectNamespace;

  return { namespace, instances, nameLog, getOptionsLog };
}

function createQueueEntry(messageId: string, ttlMs = 5_000): QueueEntry {
  return {
    enqueuedAt: Date.now(),
    expiresAt: Date.now() + ttlMs,
    message: {
      id: messageId,
      text: messageId,
      blocks: [],
      files: [],
      images: [],
      metadata: {},
      raw: null,
      reactions: [],
      timestamp: new Date(),
      threadId: "thread1",
      channelId: "channel1",
      channelVisibility: "private",
      author: {
        userId: "user-1",
        userName: "user-1",
        fullName: "User 1",
        avatarUrl: null,
        isBot: false,
        isGuest: false,
        isMe: false,
      },
    },
  };
}

describe("CloudflareDOStateAdapter", () => {
  let adapter: AdapterUnderTest;
  let mock: ReturnType<typeof createMockNamespace>;

  beforeEach(async () => {
    mock = createMockNamespace();
    adapter = createCloudflareState({
      namespace: mock.namespace,
    });
    await adapter.connect();
  });

  describe("connection", () => {
    it("throws when not connected", async () => {
      const fresh = createCloudflareState({ namespace: mock.namespace });
      await expect(fresh.subscribe("test")).rejects.toThrow("not connected");
    });

    it("connects and disconnects", async () => {
      const fresh = createCloudflareState({ namespace: mock.namespace });
      await fresh.connect();
      await fresh.subscribe("test");
      expect(await fresh.isSubscribed("test")).toBe(true);
      await fresh.disconnect();
      await expect(fresh.subscribe("test")).rejects.toThrow("not connected");
    });
  });

  describe("subscriptions", () => {
    it("subscribes and unsubscribes", async () => {
      await adapter.subscribe("slack:C123:1234.5678");
      expect(await adapter.isSubscribed("slack:C123:1234.5678")).toBe(true);
      await adapter.unsubscribe("slack:C123:1234.5678");
      expect(await adapter.isSubscribed("slack:C123:1234.5678")).toBe(false);
    });
  });

  describe("locking", () => {
    it("acquires, extends, and releases locks", async () => {
      const lock = await adapter.acquireLock("thread1", 100);
      expect(lock).not.toBeNull();
      expect(await adapter.extendLock(lock as Lock, 5_000)).toBe(true);
      expect(await adapter.acquireLock("thread1", 5_000)).toBeNull();
      await adapter.releaseLock(lock as Lock);
      expect(await adapter.acquireLock("thread1", 5_000)).not.toBeNull();
    });

    it("force releases a lock", async () => {
      const lock = await adapter.acquireLock("thread1", 5_000);
      expect(lock).not.toBeNull();
      await adapter.forceReleaseLock("thread1");
      expect(await adapter.acquireLock("thread1", 5_000)).not.toBeNull();
    });

    it("allows re-locking after expiry", async () => {
      await adapter.acquireLock("thread1", 10);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(await adapter.acquireLock("thread1", 5_000)).not.toBeNull();
    });
  });

  describe("cache", () => {
    it("sets, gets, deletes, and overwrites values", async () => {
      await adapter.set("key1", { hello: "world" });
      expect(await adapter.get("key1")).toEqual({ hello: "world" });
      await adapter.set("key1", { hello: "again" });
      expect(await adapter.get("key1")).toEqual({ hello: "again" });
      await adapter.delete("key1");
      expect(await adapter.get("key1")).toBeNull();
    });

    it("treats null like a cache miss", async () => {
      await adapter.set("null-key", null);
      expect(await adapter.get("null-key")).toBeNull();
    });

    it("respects TTL", async () => {
      await adapter.set("expiring", "value", 10);
      expect(await adapter.get("expiring")).toBe("value");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(await adapter.get("expiring")).toBeNull();
    });

    it("supports setIfNotExists for missing and expired keys", async () => {
      expect(await adapter.setIfNotExists("nx-key", "first")).toBe(true);
      expect(await adapter.setIfNotExists("nx-key", "second")).toBe(false);
      expect(await adapter.get("nx-key")).toBe("first");

      await adapter.set("expiring-nx", "old", 10);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(await adapter.setIfNotExists("expiring-nx", "new")).toBe(true);
      expect(await adapter.get("expiring-nx")).toBe("new");
    });
  });

  describe("lists", () => {
    it("appends and reads list values in insertion order", async () => {
      await adapter.appendToList("history:thread1", { text: "one" });
      await adapter.appendToList("history:thread1", { text: "two" });
      expect(
        await adapter.getList<{ text: string }>("history:thread1"),
      ).toEqual([{ text: "one" }, { text: "two" }]);
    });

    it("trims lists to maxLength and respects TTL", async () => {
      await adapter.appendToList("history:thread1", "one", {
        maxLength: 2,
        ttlMs: 10,
      });
      await adapter.appendToList("history:thread1", "two", {
        maxLength: 2,
        ttlMs: 10,
      });
      await adapter.appendToList("history:thread1", "three", {
        maxLength: 2,
        ttlMs: 10,
      });
      expect(await adapter.getList<string>("history:thread1")).toEqual([
        "two",
        "three",
      ]);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(await adapter.getList<string>("history:thread1")).toEqual([]);
    });
  });

  describe("queues", () => {
    it("enqueues, dequeues, and tracks depth", async () => {
      expect(await adapter.queueDepth("thread1")).toBe(0);
      expect(await adapter.enqueue("thread1", createQueueEntry("m1"), 5)).toBe(
        1,
      );
      expect(await adapter.enqueue("thread1", createQueueEntry("m2"), 5)).toBe(
        2,
      );
      expect(await adapter.queueDepth("thread1")).toBe(2);

      const first = await adapter.dequeue("thread1");
      const second = await adapter.dequeue("thread1");
      const third = await adapter.dequeue("thread1");

      expect(first?.message.id).toBe("m1");
      expect(second?.message.id).toBe("m2");
      expect(third).toBeNull();
      expect(await adapter.queueDepth("thread1")).toBe(0);
    });

    it("drops the oldest entry when the queue is full", async () => {
      expect(await adapter.enqueue("thread1", createQueueEntry("m1"), 1)).toBe(
        1,
      );
      expect(await adapter.enqueue("thread1", createQueueEntry("m2"), 1)).toBe(
        1,
      );
      expect(await adapter.queueDepth("thread1")).toBe(1);
      expect((await adapter.dequeue("thread1"))?.message.id).toBe("m2");
    });

    it("drops expired queue entries", async () => {
      await adapter.enqueue("thread1", createQueueEntry("m1", 10), 5);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(await adapter.queueDepth("thread1")).toBe(0);
      expect(await adapter.dequeue("thread1")).toBeNull();
    });
  });

  describe("sharding", () => {
    it("routes thread-scoped operations by shardKey", async () => {
      const shardedMock = createMockNamespace();
      const sharded = createCloudflareState({
        namespace: shardedMock.namespace,
        shardKey: (threadId) => threadId.split(":")[0] ?? "default",
      });
      await sharded.connect();

      await sharded.subscribe("slack:C123:thread1");
      await sharded.acquireLock("discord:456:thread2", 5_000);
      await sharded.enqueue("slack:C123:thread1", createQueueEntry("m1"), 5);

      expect(shardedMock.nameLog).toEqual(["slack", "discord", "slack"]);
    });

    it("routes cache and list operations to the default shard", async () => {
      const shardedMock = createMockNamespace();
      const sharded = createCloudflareState({
        namespace: shardedMock.namespace,
        name: "cache-shard",
        shardKey: (threadId) => threadId.split(":")[0] ?? "default",
      });
      await sharded.connect();

      await sharded.set("some-key", "some-value");
      await sharded.get("some-key");
      await sharded.appendToList("history:thread1", "one");
      await sharded.getList("history:thread1");

      expect(shardedMock.nameLog).toEqual([
        "cache-shard",
        "cache-shard",
        "cache-shard",
        "cache-shard",
      ]);
    });

    it("forwards locationHint to namespace.get()", async () => {
      const hintMock = createMockNamespace();
      const hinted = createCloudflareState({
        namespace: hintMock.namespace,
        locationHint: "enam",
      });
      await hinted.connect();
      await hinted.subscribe("thread1");
      expect(hintMock.getOptionsLog[0]).toEqual({ locationHint: "enam" });
    });
  });

  describe("exports", () => {
    it("exports createCloudflareState", () => {
      expect(typeof createCloudflareState).toBe("function");
    });

    it("creates an adapter instance", () => {
      const instance = createCloudflareState({ namespace: mock.namespace });
      expect(instance).toBeInstanceOf(CloudflareDOStateAdapter);
    });
  });
});
