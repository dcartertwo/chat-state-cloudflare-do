# chat-state-cloudflare-do

[![CI](https://github.com/dcartertwo/chat-state-cloudflare-do/actions/workflows/ci.yml/badge.svg)](https://github.com/dcartertwo/chat-state-cloudflare-do/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/chat-state-cloudflare-do)](https://www.npmjs.com/package/chat-state-cloudflare-do)
[![npm downloads](https://img.shields.io/npm/dm/chat-state-cloudflare-do)](https://www.npmjs.com/package/chat-state-cloudflare-do)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

Cloudflare Durable Objects state adapter for [Chat SDK](https://chat-sdk.dev/docs). Uses a SQLite-backed [Durable Object](https://developers.cloudflare.com/durable-objects/) for persistent subscriptions, distributed locking, queueing, list-backed message history, and caching — with zero external dependencies beyond the Workers runtime.

## Installation

```bash
npm install chat@^4.26 chat-state-cloudflare-do @chat-adapter/slack
```

## Usage

```typescript
import { Chat } from "chat";
import { createSlackAdapter } from "@chat-adapter/slack";
import { createCloudflareState, ChatStateDO } from "chat-state-cloudflare-do";

// Re-export the Durable Object class so Cloudflare can find it
export { ChatStateDO };

export default {
  async fetch(request: Request, env: Env) {
    const bot = new Chat({
      userName: "my-bot",
      adapters: { slack: createSlackAdapter() },
      state: createCloudflareState({ namespace: env.CHAT_STATE }),
    });
    return bot.webhooks.slack(request);
  },
};
```

### Wrangler configuration

Add the Durable Object binding and migration to your `wrangler.jsonc` (recommended) or `wrangler.toml`:

**wrangler.jsonc** (recommended)

```jsonc
{
  "observability": { "enabled": true },
  "durable_objects": {
    "bindings": [
      { "name": "CHAT_STATE", "class_name": "ChatStateDO" }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["ChatStateDO"] }
  ]
}
```

**wrangler.toml**

```toml
[observability]
enabled = true

[durable_objects]
bindings = [
  { name = "CHAT_STATE", class_name = "ChatStateDO" }
]

[[migrations]]
tag = "v1"
new_sqlite_classes = ["ChatStateDO"]
```

### Environment type

```typescript
import type { ChatStateDO } from "chat-state-cloudflare-do";

interface Env {
  CHAT_STATE: DurableObjectNamespace<ChatStateDO>;
}
```

## Configuration

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `namespace` | `DurableObjectNamespace<ChatStateDO>` | Yes | — | Durable Object namespace binding from wrangler config |
| `name` | `string` | No | `"default"` | Name for the DO instance |
| `shardKey` | `(threadId: string) => string` | No | — | Function to derive a shard name from a thread ID |
| `locationHint` | `DurableObjectLocationHint` | No | — | [Location hint](https://developers.cloudflare.com/durable-objects/reference/data-location/) for DO placement |
| `jurisdiction` | `"eu" \| "us" \| "fedramp"` | No | — | Restrict DO compute and storage to a [jurisdiction](https://developers.cloudflare.com/durable-objects/reference/data-location/#restrict-durable-objects-to-a-jurisdiction) |

## Data jurisdiction

Use `jurisdiction` when chat state must run and persist inside a supported region:

```typescript
const state = createCloudflareState({
  namespace: env.CHAT_STATE,
  jurisdiction: "us",
});
```

Jurisdictions are stronger than `locationHint`: a jurisdiction restricts where the Durable Object can run and store data, while a location hint only influences first placement for latency.

Choose a jurisdiction before first production use. Unscoped Durable Objects and jurisdiction-scoped Durable Objects have distinct identities: the same `name` or `shardKey` value maps to different objects in `eu`, `us`, and `fedramp`. Enabling or changing `jurisdiction` on an existing deployment starts reading from a different namespace, so existing subscriptions, locks, cache, queues, and lists will appear empty unless you plan a data migration.

Note: local `workerd` testing may not enforce jurisdiction restrictions yet; verify jurisdiction behavior in a deployed Worker.

## Sharding

A single Durable Object handles approximately 500-1,000 requests per second. For high-traffic bots, use `shardKey` to distribute load across multiple DO instances:

```typescript
const state = createCloudflareState({
  namespace: env.CHAT_STATE,
  shardKey: (threadId) => threadId.split(":")[0], // One DO per platform
});
```

Locks, force-release, and queue operations are per-thread, so sharding by any prefix of the thread ID is safe. Cache and list operations (`get`/`set`/`delete`, `appendToList`/`getList`) always route to the default shard since their keys are not thread-scoped.

| Strategy | `shardKey` | DOs created |
|----------|-----------|-------------|
| No sharding (default) | — | 1 |
| Per platform | `(id) => id.split(":")[0]` | 1 per platform |
| Per channel | `(id) => id.split(":").slice(0, 2).join(":")` | 1 per channel |

## Architecture

The adapter uses a single Durable Object class (`ChatStateDO`) with five SQLite tables:

- **`subscriptions`** — thread IDs the bot is subscribed to
- **`locks`** — distributed locks with token-based ownership and TTL
- **`cache`** — key-value pairs with optional TTL
- **`queue`** — thread-scoped FIFO queue entries with TTL for concurrency strategies
- **`lists`** — ordered list entries for persistent message history

All operations are single-threaded within a DO instance, providing distributed locking via DO atomicity rather than Lua scripts. Expired entries are cleaned up automatically via the [Alarms API](https://developers.cloudflare.com/durable-objects/api/alarms/).

Each method call creates a fresh DO stub. Stubs are cheap (just a JS object) and the [Cloudflare docs recommend](https://developers.cloudflare.com/durable-objects/best-practices/error-handling/) creating new stubs rather than reusing them after errors.

## Features

- Persistent subscriptions across deployments
- Distributed locking via single-threaded DO atomicity
- Lock force-release for Chat SDK lock conflict handling
- Queue/debounce concurrency primitives
- List-backed persistent message history
- Key-value caching with TTL
- Automatic TTL cleanup via Alarms
- Optional sharding for high-traffic bots
- Location hints for latency optimization
- Zero external dependencies (no Redis, no database)

## Production recommendations

- Use [Smart Placement](https://developers.cloudflare.com/workers/configuration/smart-placement/) to co-locate your Worker with the DO
- Enable `observability.enabled` in Wrangler and monitor DO logs and metrics in the [Cloudflare dashboard](https://dash.cloudflare.com/)
- Watch the DO memory usage chart for regressions after deployments
- Enable sharding if you expect >500 req/s to a single DO instance
- Use `locationHint` to place the DO near your primary user base

## Documentation

- [npm package](https://www.npmjs.com/package/chat-state-cloudflare-do)
- [Chat SDK docs](https://chat-sdk.dev/docs)
- [State adapters overview](https://chat-sdk.dev/docs/state-adapters)
- [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/)

## License

MIT
