// Rate limiting contract. The server asks "may this key act once more?" and nothing else; where
// the counters live (memory, KV, Durable Object, Redis, a platform rate-limit binding) is the host's
// choice. Only dynamic client registration is limited today, since it is the one unauthenticated
// endpoint that writes to storage.

export interface RateLimiter {
  /** Return true to allow the action, false to refuse it with HTTP 429. */
  allow(key: string): Promise<boolean>;
}

export interface RateLimitConfig {
  limiter: RateLimiter;
  /** Derive the counter key from the request. Default: client IP from `cf-connecting-ip` / `x-forwarded-for`, else `'local'`. */
  key?: (request: Request) => string;
}

export function defaultRateLimitKey(request: Request) {
  return request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'local';
}

/**
 * Reference limiter: a sliding window per key held in process memory. Correct on a single long-lived
 * process; on multi-instance or isolate-per-request runtimes (Cloudflare Workers, Lambda) each instance
 * counts separately, so use your platform's shared primitive there.
 */
export function memoryRateLimiter(options: { limit?: number; windowMs?: number } = {}): RateLimiter {
  const limit = options.limit ?? 20;
  const windowMs = options.windowMs ?? 60 * 60 * 1000;
  const hits = new Map<string, number[]>();
  return {
    async allow(key) {
      const cutoff = Date.now() - windowMs;
      const recent = (hits.get(key) || []).filter((at) => at > cutoff);
      if (recent.length >= limit) return false;
      recent.push(Date.now());
      hits.set(key, recent);
      return true;
    },
  };
}
