/**
 * Fixed-window rate limiting, backed by Postgres.
 *
 * Serverless functions have no shared memory, so an in-process counter would
 * reset on every cold start. Neon is already a dependency and the volume here
 * is trivial (a handful of bookings a day), so one upsert per guarded request
 * is cheap. Old windows are pruned by the cleanup cron.
 */

import type { getDb } from './db';

type Sql = ReturnType<typeof getDb>;

export type RateLimitResult = {
  allowed: boolean;
  /** Requests made in the current window, including this one. */
  count: number;
  /** When the current window resets. */
  resetsAt: Date;
};

/**
 * Count one request against `bucket` and report whether it is within `limit`.
 *
 * Fails open: if the counter table is unreachable the request is allowed
 * through, because losing bookings to a transient DB error is worse than
 * letting an abusive client past.
 */
export async function consumeRateLimit(
  sql: Sql,
  bucket: string,
  limit: number,
  windowMs: number,
  now: Date = new Date(),
): Promise<RateLimitResult> {
  const windowStartMs = Math.floor(now.getTime() / windowMs) * windowMs;
  const windowStart = new Date(windowStartMs);
  const resetsAt = new Date(windowStartMs + windowMs);

  try {
    const rows = (await sql`
      INSERT INTO rate_limits (bucket, window_start, count)
      VALUES (${bucket}, ${windowStart.toISOString()}, 1)
      ON CONFLICT (bucket, window_start)
      DO UPDATE SET count = rate_limits.count + 1
      RETURNING count
    `) as { count: number }[];

    const count = rows[0]?.count ?? 1;
    return { allowed: count <= limit, count, resetsAt };
  } catch (err) {
    console.error('Rate limit check failed, allowing request:', err);
    return { allowed: true, count: 0, resetsAt };
  }
}

/**
 * Best-effort client IP. Vercel sets `x-forwarded-for`; `clientAddress` comes
 * from the Astro adapter. Falls back to a constant so a missing IP degrades to
 * one shared bucket rather than to no limiting at all.
 */
export function clientIp(request: Request, clientAddress?: string): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return request.headers.get('x-real-ip') ?? clientAddress ?? 'unknown';
}
