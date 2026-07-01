import type { QueueEntry } from "chat";
import { env } from "cloudflare:workers";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createCloudflareState } from "../src";

function uniqueName(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function createState(name = uniqueName("state")) {
  const state = createCloudflareState({
    namespace: env.CHAT_STATE,
    name,
  });
  return { name, state };
}

function makeEntry(id: number, ttlMs = 60_000): QueueEntry {
  const now = Date.now();
  return {
    enqueuedAt: now,
    expiresAt: now + ttlMs,
    message: { id } as any,
  };
}

describe("ChatStateDO runtime", () => {
  it("persists subscriptions, cache, lists, and queues across eviction", async () => {
    const { name, state } = createState(uniqueName("evict"));
    await state.connect();

    await state.subscribe("thread-1");
    await state.set("cache-key", { ok: true });
    await state.appendToList("history", "first");
    await state.appendToList("history", "second");
    await state.enqueue("thread-1", makeEntry(1), 10);

    const stub = env.CHAT_STATE.getByName(name);
    await evictDurableObject(stub);

    expect(await state.isSubscribed("thread-1")).toBe(true);
    expect(await state.get("cache-key")).toEqual({ ok: true });
    expect(await state.getList("history")).toEqual(["first", "second"]);
    expect((await state.dequeue("thread-1"))?.message).toEqual({ id: 1 });
  });

  it("cleans expired locks, cache, queue entries, and lists from alarms", async () => {
    const { name, state } = createState(uniqueName("alarm"));
    await state.connect();

    await state.acquireLock("thread-1", 5);
    await state.set("expired-cache", "value", 5);
    await state.enqueue("thread-1", makeEntry(1, 5), 10);
    await state.appendToList("expired-list", "value", { ttlMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const stub = env.CHAT_STATE.getByName(name);
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.setAlarm(Date.now());
    });
    await runDurableObjectAlarm(stub);

    const counts = await runInDurableObject(stub, (_instance, state) => ({
      cache: state.storage.sql.exec("SELECT 1 FROM cache").toArray().length,
      lists: state.storage.sql.exec("SELECT 1 FROM lists").toArray().length,
      locks: state.storage.sql.exec("SELECT 1 FROM locks").toArray().length,
      queue: state.storage.sql.exec("SELECT 1 FROM queue").toArray().length,
    }));

    expect(counts).toEqual({ cache: 0, lists: 0, locks: 0, queue: 0 });
  });
});
