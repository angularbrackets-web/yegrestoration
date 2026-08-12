/**
 * `POST /api/admin/reply/` — the office replying to a lead.
 *
 * A shell over `sendReplyAndStamp`, which owns the send-then-stamp ordering
 * and every failure arm. All four `Location` headers below are slashed and
 * built from `booking-admin.ts`'s constants: an unslashed redirect costs a 308
 * per click, and the same spelling is what made `/admin` unreachable for a
 * month (BK-07).
 */

import type { APIRoute } from 'astro';
import { z } from 'zod';

import { adminLeadPath, ADMIN_LEADS_PATH } from '../../../lib/booking-admin';
import { createResendSender } from '../../../lib/booking-notify';
import { getDb, type Lead } from '../../../lib/db';
import { readEnv } from '../../../lib/env';
import { sendReplyAndStamp } from '../../../lib/lead-reply';

export const prerender = false;

const schema = z.object({
  leadId: z.string().regex(/^\d+$/),
  subject: z.string().min(1),
  body: z.string().min(1),
});

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location } });
}

export const POST: APIRoute = async ({ request }) => {
  const form = await request.formData();
  const raw = {
    leadId: form.get('leadId') as string,
    subject: form.get('subject') as string,
    body: form.get('body') as string,
  };

  const result = schema.safeParse(raw);
  if (!result.success) return redirect(`${ADMIN_LEADS_PATH}?error=validation`);

  const { leadId, subject, body } = result.data;
  const id = Number(leadId);

  const sql = getDb();
  const rows = (await sql`SELECT * FROM leads WHERE id = ${id}`) as Lead[];
  const lead = rows[0];

  if (!lead) return redirect(ADMIN_LEADS_PATH);
  if (!lead.email) return redirect(`${adminLeadPath(id)}?error=noemail`);

  // `readEnv`, not `import.meta.env`: the latter is undefined under plain Node,
  // which is what the verification runs on. The missing-key case is a logged
  // `failed` inside the helper, not the bare `throw` this route used to do.
  const apiKey = readEnv('RESEND_API_KEY');

  const outcome = await sendReplyAndStamp(
    sql,
    { leadId: id, to: lead.email, subject, body },
    // No idempotency key: a reply the office sends twice is two deliberate
    // messages, and a fixed key would make Resend return the first attempt's
    // result — including its failure — forever.
    { send: apiKey ? createResendSender(apiKey, null) : null },
  );

  // `skipped` is the mute, and it counts as success on purpose: it is
  // test-only, and the route-level verification needs the success path.
  if (outcome === 'failed') return redirect(`${adminLeadPath(id)}?error=sendfailed`);
  return redirect(`${adminLeadPath(id)}?success=1`);
};
