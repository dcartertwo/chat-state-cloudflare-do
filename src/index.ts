export { CloudflareDOStateAdapter } from "./adapter";
export { ChatStateDO } from "./durable-object";
export type { CloudflareStateOptions } from "./types";

import { CloudflareDOStateAdapter } from "./adapter";
import type { CloudflareStateOptions } from "./types";

/**
 * Create a Cloudflare Durable Objects state adapter for Chat SDK.
 *
 * Uses a SQLite-backed Durable Object for persistent subscriptions,
 * distributed locking (via single-threaded atomicity), and key-value
 * caching. Zero external dependencies beyond Cloudflare Workers.
 *
 * @example
 * ```typescript
 * import { Chat } from "chat";
 * import { createSlackAdapter } from "@chat-adapter/slack";
 * import { createCloudflareState, ChatStateDO } from "chat-state-cloudflare-do";
 *
 * // Re-export the DO class so Cloudflare can find it
 * export { ChatStateDO };
 *
 * export default {
 *   async fetch(request: Request, env: Env) {
 *     const bot = new Chat({
 *       userName: "my-bot",
 *       adapters: { slack: createSlackAdapter() },
 *       state: createCloudflareState({ namespace: env.CHAT_STATE }),
 *     });
 *     return bot.webhooks.slack(request);
 *   },
 * };
 * ```
 */
export function createCloudflareState(
  options: CloudflareStateOptions
): CloudflareDOStateAdapter {
  return new CloudflareDOStateAdapter(options);
}
