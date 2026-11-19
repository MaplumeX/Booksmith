export interface RateLimiter {
  /** Returns true when the key may proceed, false when it is over budget. */
  hit(key: string): boolean
  reset(key: string): void
}

export function createRateLimiter(options: { max: number; windowMs: number }): RateLimiter {
  const buckets = new Map<string, { count: number; resetAt: number }>()

  return {
    hit(key) {
      const now = Date.now()
      const bucket = buckets.get(key)
      if (!bucket || bucket.resetAt <= now) {
        buckets.set(key, { count: 1, resetAt: now + options.windowMs })
        return true
      }
      bucket.count += 1
      return bucket.count <= options.max
    },
    reset(key) {
      buckets.delete(key)
    },
  }
}
