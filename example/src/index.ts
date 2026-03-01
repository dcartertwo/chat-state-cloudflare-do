import {
  createCloudflareState,
  ChatStateDO,
} from "chat-state-cloudflare-do";

export { ChatStateDO };

interface Env {
  CHAT_STATE: DurableObjectNamespace<ChatStateDO>;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;

    // Create and connect the state adapter
    const state = createCloudflareState({ namespace: env.CHAT_STATE });
    await state.connect();

    try {
      // -- UI ---------------------------------------------------------------
      if (path === "/" || path === "") {
        return new Response(HTML, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      // -- Subscriptions ----------------------------------------------------

      // POST /subscribe/:threadId
      if (method === "POST" && path.startsWith("/subscribe/")) {
        const threadId = decodeURIComponent(path.slice("/subscribe/".length));
        await state.subscribe(threadId);
        return json({ ok: true, action: "subscribed", threadId });
      }

      // DELETE /subscribe/:threadId
      if (method === "DELETE" && path.startsWith("/subscribe/")) {
        const threadId = decodeURIComponent(path.slice("/subscribe/".length));
        await state.unsubscribe(threadId);
        return json({ ok: true, action: "unsubscribed", threadId });
      }

      // GET /subscribe/:threadId
      if (method === "GET" && path.startsWith("/subscribe/")) {
        const threadId = decodeURIComponent(path.slice("/subscribe/".length));
        const subscribed = await state.isSubscribed(threadId);
        return json({ threadId, subscribed });
      }

      // -- Locks ------------------------------------------------------------

      // POST /lock/:threadId?ttl=5000
      if (method === "POST" && path.startsWith("/lock/")) {
        const threadId = decodeURIComponent(path.slice("/lock/".length));
        const ttl = Number(url.searchParams.get("ttl") ?? "5000");
        const lock = await state.acquireLock(threadId, ttl);
        if (lock) {
          return json({ ok: true, action: "acquired", lock });
        }
        return json({ ok: false, action: "already_locked", threadId }, 409);
      }

      // DELETE /lock/:threadId?token=...
      if (method === "DELETE" && path.startsWith("/lock/")) {
        const threadId = decodeURIComponent(path.slice("/lock/".length));
        const token = url.searchParams.get("token");
        if (!token) {
          return json({ error: "token query param required" }, 400);
        }
        await state.releaseLock({
          threadId,
          token,
          expiresAt: Date.now() + 60000,
        });
        return json({ ok: true, action: "released", threadId });
      }

      // -- Cache ------------------------------------------------------------

      // GET /cache/:key
      if (method === "GET" && path.startsWith("/cache/")) {
        const key = decodeURIComponent(path.slice("/cache/".length));
        const value = await state.get(key);
        return json({ key, value, found: value !== null });
      }

      // POST /cache/:key?ttl=5000  (body = JSON value)
      if (method === "POST" && path.startsWith("/cache/")) {
        const key = decodeURIComponent(path.slice("/cache/".length));
        const ttlParam = url.searchParams.get("ttl");
        const ttl = ttlParam ? Number(ttlParam) : undefined;
        const body = await request.json();
        await state.set(key, body, ttl);
        return json({ ok: true, action: "set", key, ttl: ttl ?? null });
      }

      // DELETE /cache/:key
      if (method === "DELETE" && path.startsWith("/cache/")) {
        const key = decodeURIComponent(path.slice("/cache/".length));
        await state.delete(key);
        return json({ ok: true, action: "deleted", key });
      }

      return json({ error: "not found" }, 404);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return json({ error: message }, 500);
    }
  },
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>chat-state-cloudflare-do — Example</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #0a0a0a; color: #e5e5e5; padding: 2rem; max-width: 720px; margin: 0 auto; }
    h1 { font-size: 1.5rem; margin-bottom: 0.25rem; }
    h1 span { color: #f97316; }
    p.sub { color: #888; margin-bottom: 2rem; font-size: 0.875rem; }
    h2 { font-size: 1rem; color: #f97316; margin: 1.5rem 0 0.75rem; border-bottom: 1px solid #222; padding-bottom: 0.5rem; }
    .row { display: flex; gap: 0.5rem; margin-bottom: 0.5rem; align-items: center; }
    input { background: #1a1a1a; border: 1px solid #333; color: #e5e5e5; padding: 0.4rem 0.6rem; border-radius: 4px; font-size: 0.875rem; flex: 1; }
    button { background: #f97316; color: #000; border: none; padding: 0.4rem 0.75rem; border-radius: 4px; cursor: pointer; font-size: 0.875rem; font-weight: 600; white-space: nowrap; }
    button:hover { background: #fb923c; }
    button.red { background: #ef4444; color: #fff; }
    button.red:hover { background: #f87171; }
    button.blue { background: #3b82f6; color: #fff; }
    button.blue:hover { background: #60a5fa; }
    pre { background: #111; border: 1px solid #222; padding: 1rem; border-radius: 6px; overflow-x: auto; font-size: 0.8rem; margin-top: 1rem; min-height: 3rem; color: #a3e635; }
  </style>
</head>
<body>
  <h1><span>chat-state-cloudflare-do</span> example</h1>
  <p class="sub">Exercise every StateAdapter method against a live Durable Object.</p>

  <h2>Subscriptions</h2>
  <div class="row">
    <input id="sub-id" value="slack:C123:thread1" placeholder="thread ID">
    <button onclick="api('POST','/subscribe/'+enc(g('sub-id')))">Subscribe</button>
    <button class="red" onclick="api('DELETE','/subscribe/'+enc(g('sub-id')))">Unsubscribe</button>
    <button class="blue" onclick="api('GET','/subscribe/'+enc(g('sub-id')))">Check</button>
  </div>

  <h2>Locks</h2>
  <div class="row">
    <input id="lock-id" value="slack:C123:thread1" placeholder="thread ID">
    <input id="lock-ttl" value="5000" placeholder="TTL (ms)" style="max-width:100px">
    <button onclick="api('POST','/lock/'+enc(g('lock-id'))+'?ttl='+g('lock-ttl'))">Acquire</button>
  </div>
  <div class="row">
    <input id="lock-token" placeholder="token (from acquire response)">
    <button class="red" onclick="api('DELETE','/lock/'+enc(g('lock-id'))+'?token='+enc(g('lock-token')))">Release</button>
  </div>

  <h2>Cache</h2>
  <div class="row">
    <input id="cache-key" value="my-key" placeholder="key">
    <input id="cache-val" value='{"hello":"world"}' placeholder="JSON value">
    <input id="cache-ttl" value="" placeholder="TTL (ms, optional)" style="max-width:120px">
  </div>
  <div class="row">
    <button onclick="cacheSet()">Set</button>
    <button class="blue" onclick="api('GET','/cache/'+enc(g('cache-key')))">Get</button>
    <button class="red" onclick="api('DELETE','/cache/'+enc(g('cache-key')))">Delete</button>
  </div>

  <pre id="out">// responses appear here</pre>

  <script>
    const g = id => document.getElementById(id).value;
    const enc = s => encodeURIComponent(s);
    const out = document.getElementById('out');

    async function api(method, path, body) {
      const opts = { method };
      if (body !== undefined) {
        opts.body = JSON.stringify(body);
        opts.headers = { 'content-type': 'application/json' };
      }
      try {
        const res = await fetch(path, opts);
        const data = await res.json();
        out.textContent = method + ' ' + path + '\\n\\n' + JSON.stringify(data, null, 2);
      } catch (err) {
        out.textContent = 'Error: ' + err.message;
      }
    }

    function cacheSet() {
      const key = g('cache-key');
      const ttl = g('cache-ttl');
      const path = '/cache/' + enc(key) + (ttl ? '?ttl=' + ttl : '');
      let val;
      try { val = JSON.parse(g('cache-val')); } catch { val = g('cache-val'); }
      api('POST', path, val);
    }
  </script>
</body>
</html>`;
