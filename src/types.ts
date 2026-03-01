import type { ChatStateDO } from "./durable-object";

/**
 * Configuration for the Cloudflare Durable Objects state adapter.
 */
export interface CloudflareStateOptions {
  /**
   * Location hint for DO placement. Influences where the DO instance
   * is created on first access. This is a suggestion, not a guarantee.
   *
   * @see https://developers.cloudflare.com/durable-objects/reference/data-location/
   */
  locationHint?: DurableObjectLocationHint;

  /**
   * Name for the DO instance. Defaults to `"default"`.
   *
   * All state (subscriptions, locks, cache) is stored in the DO
   * identified by this name. For high-traffic bots, use `shardKey`
   * instead to distribute load across multiple DO instances.
   */
  name?: string;
  /**
   * DurableObjectNamespace binding for the ChatStateDO class.
   * Must be bound in your wrangler.toml or wrangler.jsonc.
   *
   * @example
   * ```toml
   * [durable_objects]
   * bindings = [{ name = "CHAT_STATE", class_name = "ChatStateDO" }]
   *
   * [[migrations]]
   * tag = "v1"
   * new_sqlite_classes = ["ChatStateDO"]
   * ```
   */
  namespace: DurableObjectNamespace<ChatStateDO>;

  /**
   * Optional function to derive a DO instance name from a thread ID.
   *
   * When provided, each unique return value maps to a separate DO instance,
   * distributing load across shards. A single Durable Object handles
   * approximately 500–1,000 requests per second, so sharding is only
   * needed for very high-traffic bots.
   *
   * Locks and subscriptions are per-thread, so sharding by any prefix
   * of the thread ID is safe — operations on different threads are
   * independent.
   *
   * Cache operations (`get`/`set`/`delete`) always route to the default
   * shard since their keys are not thread-scoped.
   *
   * @example
   * ```typescript
   * // Shard by platform adapter (one DO per platform)
   * shardKey: (threadId) => threadId.split(":")[0]
   *
   * // Shard by channel
   * shardKey: (threadId) => threadId.split(":").slice(0, 2).join(":")
   * ```
   */
  shardKey?: (threadId: string) => string;
}
