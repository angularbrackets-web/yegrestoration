import type { APIRoute } from 'astro';
import { Resend } from 'resend';
import { z } from 'zod';
import { getDb, type Lead } from '../../../lib/db';

export const prerender = false;

const schema = z.object({
  leadId: z.string().regex(/^\d+$/),
  subject: z.string().min(1),
  body: z.string().min(1),
});

function escapeHtml(s: string) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export const POST: APIRoute = async ({ request }) => {
  const form = await request.formData();
  const raw = {
    leadId: form.get('leadId') as string,
    subject: form.get('subject') as string,
    body: form.get('body') as string,
  };

  const result = schema.safeParse(raw);
  if (!result.success) {
    return new Response(null, { status: 302, headers: { Location: '/admin?error=validation' } });
  }

  const { leadId, subject, body } = result.data;

  const sql = getDb();
  const rows = (await sql`SELECT * FROM leads WHERE id = ${leadId}`) as Lead[];
  const lead = rows[0];

  if (!lead) {
    return new Response(null, { status: 302, headers: { Location: '/admin' } });
  }
  if (!lead.email) {
    return new Response(null, {
      status: 302,
      headers: { Location: `/admin/leads/${leadId}?error=noemail` },
    });
  }

  const apiKey = import.meta.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY not set');

  const resend = new Resend(apiKey);
  await resend.emails.send({
    from: 'YEG Restoration <info@yegrestoration.ca>',
    to: [lead.email],
    replyTo: 'info@yegrestoration.ca',
    subject,
    html: `<div style="font-family:sans-serif;font-size:15px;line-height:1.6;white-space:pre-wrap;max-width:600px;">${escapeHtml(body)}</div>`,
    text: body,
  });

  await sql`UPDATE leads SET status = 'replied', replied_at = NOW() WHERE id = ${leadId}`;

  return new Response(null, {
    status: 302,
    headers: { Location: `/admin/leads/${leadId}?success=1` },
  });
};
