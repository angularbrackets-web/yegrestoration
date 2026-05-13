import type { APIRoute } from 'astro';

export const prerender = false;
import { Resend } from 'resend';
import { z } from 'zod';

const schema = z.object({
  name: z.string().min(2),
  phone: z.string().min(7),
  email: z.string().email().optional().or(z.literal('')),
  service: z.string().min(1),
  message: z.string().optional(),
});

const serviceLabels: Record<string, string> = {
  water: 'Water Damage Restoration',
  fire: 'Fire Damage Restoration',
  mold: 'Mold Removal',
  storm: 'Storm Damage Repair',
  construction: 'Construction Services',
  contents: 'Contents Restoration',
  biohazard: 'Biohazard Cleaning',
  asbestos: 'Asbestos Abatement',
  other: 'Other Emergency',
};

function escapeHtml(s: string) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function json(data: object, status: number) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const POST: APIRoute = async ({ request }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid request' }, 400);
  }

  const result = schema.safeParse(body);
  if (!result.success) return json({ error: 'Validation failed' }, 422);

  const { name, phone, email, service, message } = result.data;
  const serviceLabel = serviceLabels[service] ?? service;

  const apiKey = import.meta.env.RESEND_API_KEY;
  if (!apiKey) return json({ error: 'Server configuration error' }, 500);

  const resend = new Resend(apiKey);
  try {
    await resend.emails.send({
      from: 'YEG Restoration <noreply@yegrestoration.ca>',
      to: ['info@yegrestoration.ca'],
      replyTo: email || undefined,
      subject: `New Quote Request — ${serviceLabel}`,
      html: `
        <h2 style="font-family:sans-serif;margin-bottom:16px;">New Quote Request</h2>
        <table style="font-family:sans-serif;border-collapse:collapse;width:100%;max-width:500px;">
          <tr>
            <td style="padding:8px 12px;background:#f5f5f5;font-weight:600;width:100px;">Name</td>
            <td style="padding:8px 12px;border-bottom:1px solid #eee;">${escapeHtml(name)}</td>
          </tr>
          <tr>
            <td style="padding:8px 12px;background:#f5f5f5;font-weight:600;">Phone</td>
            <td style="padding:8px 12px;border-bottom:1px solid #eee;">${escapeHtml(phone)}</td>
          </tr>
          <tr>
            <td style="padding:8px 12px;background:#f5f5f5;font-weight:600;">Email</td>
            <td style="padding:8px 12px;border-bottom:1px solid #eee;">${email ? escapeHtml(email) : '—'}</td>
          </tr>
          <tr>
            <td style="padding:8px 12px;background:#f5f5f5;font-weight:600;">Service</td>
            <td style="padding:8px 12px;border-bottom:1px solid #eee;">${escapeHtml(serviceLabel)}</td>
          </tr>
          <tr>
            <td style="padding:8px 12px;background:#f5f5f5;font-weight:600;vertical-align:top;">Message</td>
            <td style="padding:8px 12px;">${message ? escapeHtml(message).replace(/\n/g, '<br>') : '—'}</td>
          </tr>
        </table>
      `,
      text: [
        `New Quote Request — ${serviceLabel}`,
        '',
        `Name:    ${name}`,
        `Phone:   ${phone}`,
        `Email:   ${email || '—'}`,
        `Service: ${serviceLabel}`,
        `Message: ${message || '—'}`,
      ].join('\n'),
    });
    return json({ ok: true }, 200);
  } catch (err) {
    console.error('Resend error:', err);
    return json({ error: 'Failed to send email' }, 500);
  }
};
