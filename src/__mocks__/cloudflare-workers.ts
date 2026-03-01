/**
 * Mock for `cloudflare:workers` module.
 *
 * Provides a stub DurableObject base class so that unit tests can
 * import the adapter (which re-exports ChatStateDO) without requiring
 * the Cloudflare Workers runtime.
 */
export class DurableObject {
  protected ctx: unknown;
  protected env: unknown;

  constructor(ctx: unknown, env: unknown) {
    this.ctx = ctx;
    this.env = env;
  }
}
