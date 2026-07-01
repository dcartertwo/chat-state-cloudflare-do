import type { ChatStateDO } from "../src";

declare global {
  namespace Cloudflare {
    interface Env {
      CHAT_STATE: DurableObjectNamespace<ChatStateDO>;
    }
  }
}

declare module "cloudflare:workers" {
  interface ProvidedEnv extends Cloudflare.Env {
    CHAT_STATE: DurableObjectNamespace<ChatStateDO>;
  }
}
