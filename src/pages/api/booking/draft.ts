import type { APIRoute } from 'astro';

export const prerender = false;

import {
  ALLOWED_UPLOAD_TYPES,
  DRAFT_RATE_LIMIT_PER_HOUR,
  MAX_FILES_PER_BOOKING,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
} from '../../../lib/booking-config';
import { getDb } from '../../../lib/db';
import { issueDraftToken } from '../../../lib/draft-token';
import { clientIp, consumeRateLimit } from '../../../lib/rate-limit';

const HOUR_MS = 60 * 60 * 1000;

function json(data: object, status: number, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/**
 * Opens an upload session for the booking form.
 *
 * The returned token is what authorizes `/api/booking/upload-token` to mint
 * Blob client tokens. Rate limiting lives here rather than on the upload route
 * because this is the narrow end of the funnel: without a draft there are no
 * uploads, and each draft is independently capped at 10 files / 300 MB.
 */
export const POST: APIRoute = async ({ request, clientAddress }) => {
  const ip = clientIp(request, clientAddress);

  const limit = await consumeRateLimit(
    getDb(),
    `booking-draft:${ip}`,
    DRAFT_RATE_LIMIT_PER_HOUR,
    HOUR_MS,
  );

  if (!limit.allowed) {
    const retryAfter = Math.max(1, Math.ceil((limit.resetsAt.getTime() - Date.now()) / 1000));
    return json({ error: 'Too many requests. Please try again shortly.' }, 429, {
      'Retry-After': String(retryAfter),
    });
  }

  let draft;
  try {
    draft = await issueDraftToken();
  } catch (err) {
    console.error('Could not issue draft token:', err);
    return json({ error: 'Server configuration error' }, 500);
  }

  return json(
    {
      draftId: draft.draftId,
      draftToken: draft.token,
      limits: {
        maxFiles: MAX_FILES_PER_BOOKING,
        maxFileBytes: MAX_FILE_BYTES,
        maxTotalBytes: MAX_TOTAL_BYTES,
        allowedTypes: ALLOWED_UPLOAD_TYPES,
      },
    },
    200,
  );
};
