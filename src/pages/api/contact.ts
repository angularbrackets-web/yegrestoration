/**
 * `POST /api/contact/` — the message form's endpoint.
 *
 * A shell, deliberately. Parse, wire the real dependencies, map the outcome to
 * a Response: every decision this route used to make now lives in
 * `src/lib/contact-message.ts`, where a script can drive all four arms of the
 * truth table with an injected sender. The reasoning — including why a send
 * failure is a 500 even when the row landed — is documented there.
 */

import type { APIRoute } from 'astro';

import { createResendSender } from '../../lib/booking-notify';
import { handleContactMessage, parseContactSubmission } from '../../lib/contact-message';
import { readEnv } from '../../lib/env';
import { getDb, SERVICE_LABELS } from '../../lib/db';

export const prerender = false;

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

  const parsed = parseContactSubmission(body);
  if (!parsed.ok) return json({ error: 'Validation failed' }, 422);

  // `readEnv`, not a bare `import.meta.env` read: the latter is undefined under
  // plain Node, which blocks the tsx-driven verification outright, and it is
  // the BK-12 rule for every server-side variable. (`PUBLIC_*` is the exact
  // opposite and must stay a literal expression — see the ROADMAP.)
  const apiKey = readEnv('RESEND_API_KEY');

  const outcome = await handleContactMessage(parsed.message, {
    labelFor: (service) => SERVICE_LABELS[service] ?? service,
    insert: async (message) => {
      const sql = getDb();
      await sql`
        INSERT INTO leads (name, phone, email, service, message)
        VALUES (${message.name}, ${message.phone}, ${message.email}, ${message.service}, ${message.message})
      `;
    },
    // Null when the key is unset. The lib logs that as its own arm rather than
    // letting `new Resend(undefined)` throw somewhere less legible.
    send: apiKey ? createResendSender(apiKey, null) : null,
  });

  if (outcome.ok) return json({ ok: true }, 200);
  return json({ error: 'Failed to send message' }, 500);
};
