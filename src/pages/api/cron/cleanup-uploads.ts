import type { APIRoute } from 'astro';

export const prerender = false;

import { del } from '@vercel/blob';
import { UPLOAD_ORPHAN_TTL_HOURS } from '../../../lib/booking-config';
import { getDb } from '../../../lib/db';

/** Bounded so a large backlog is worked off across several runs rather than timing out. */
const BATCH_SIZE = 200;

/** Rate-limit windows are worthless once they have closed. */
const RATE_LIMIT_RETENTION_HOURS = 48;

/**
 * Deletes uploads that were never claimed by a booking.
 *
 * Files reach Blob storage before the appointment row exists, so an abandoned
 * form leaves paid-for bytes behind. Every upload has an `appointment_files`
 * row from the moment its token is minted, which makes the orphan set a plain
 * query rather than a storage listing diff.
 *
 * Blobs are deleted before their rows: `del()` does not throw on an already
 * deleted blob, so a failure part way through simply retries next run. Doing
 * it the other way round would lose track of the blob entirely.
 *
 * Scheduled hourly in vercel.json. Vercel attaches `Authorization: Bearer
 * $CRON_SECRET` when that variable is set on the project.
 */
export const GET: APIRoute = async ({ request }) => {
  const secret = process.env.CRON_SECRET ?? import.meta.env.CRON_SECRET;
  if (!secret) {
    console.error('CRON_SECRET is not configured — refusing to run cleanup.');
    return Response.json({ error: 'Not configured' }, { status: 500 });
  }
  if (request.headers.get('authorization') !== `Bearer ${secret}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const sql = getDb();
  const cutoff = new Date(Date.now() - UPLOAD_ORPHAN_TTL_HOURS * 60 * 60 * 1000).toISOString();

  let blobsDeleted = 0;
  let rowsDeleted = 0;

  try {
    const orphans = (await sql`
      SELECT id, pathname
      FROM appointment_files
      WHERE appointment_id IS NULL
        AND created_at < ${cutoff}
      ORDER BY created_at
      LIMIT ${BATCH_SIZE}
    `) as { id: number; pathname: string }[];

    if (orphans.length > 0) {
      await del(orphans.map((o) => o.pathname));
      blobsDeleted = orphans.length;

      const ids = orphans.map((o) => o.id);
      const removed = (await sql`
        DELETE FROM appointment_files
        WHERE id = ANY(${ids}::int[])
        RETURNING id
      `) as { id: number }[];
      rowsDeleted = removed.length;
    }
  } catch (err) {
    console.error('Orphaned upload cleanup failed:', err);
    return Response.json({ error: 'Cleanup failed' }, { status: 500 });
  }

  let rateLimitRowsDeleted = 0;
  try {
    const staleWindow = new Date(
      Date.now() - RATE_LIMIT_RETENTION_HOURS * 60 * 60 * 1000,
    ).toISOString();
    const pruned = (await sql`
      DELETE FROM rate_limits
      WHERE window_start < ${staleWindow}
      RETURNING bucket
    `) as { bucket: string }[];
    rateLimitRowsDeleted = pruned.length;
  } catch (err) {
    // Non-fatal — the counters are correct either way, just larger than needed.
    console.error('Rate limit prune failed:', err);
  }

  return Response.json({
    ok: true,
    blobsDeleted,
    rowsDeleted,
    rateLimitRowsDeleted,
    moreRemaining: blobsDeleted === BATCH_SIZE,
  });
};
