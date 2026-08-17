/**
 * Signed booking drafts.
 *
 * The public booking form has no user session, but Vercel Blob requires the
 * upload-token route to authorize the caller — without that, the route is an
 * open file host. A draft token is the authorization primitive: the form asks
 * for one before it can upload anything, and every upload must sit under the
 * prefix of a draft the server itself issued and signed.
 *
 * Stateless by design (HMAC rather than a drafts table), so an abandoned form
 * costs nothing. Abuse is bounded on the other side: draft issuance is
 * rate-limited per IP, and each draft caps file count and total bytes.
 */

import { APPOINTMENT_UPLOAD_TTL_HOURS, DRAFT_TOKEN_TTL_HOURS } from './booking-config';
import { readEnv } from './env';

const TOKEN_VERSION = 'v1';

/**
 * The appointment-upload token's version tag (BK-34a).
 *
 * TWO TOKEN TYPES OVER ONE SECRET IS WHERE A CONFUSED-DEPUTY BUG LIVES, so the
 * separation is made three times over rather than once:
 *
 *   1. **Different version tag.** `v1` vs `a1`, checked before anything else.
 *   2. **Different arity.** A draft token has 4 dot-separated parts, an
 *      appointment token 5. Each verifier rejects the other's shape outright.
 *   3. **Different signed payload.** `<draftId>.<issuedAt>` vs
 *      `<appointmentId>.<draftId>.<issuedAt>` — so even if the first two checks
 *      were somehow bypassed, the HMAC over one shape does not verify as the
 *      other.
 *
 * Any one of these would do. All three are here because the failure mode is a
 * token minted for a 6-hour form session being replayed as a 72-hour write
 * capability against somebody's appointment, and that is not a bug worth
 * leaving to a single `if`.
 *
 * THERE IS A FOURTH, AND IT IS NOT SHAPE-CHECKING YOU CAN DELETE AS REDUNDANT:
 * the `/^[1-9][0-9]*$/` test on the appointment id in
 * `verifyAppointmentUploadToken`. The id is re-canonicalised through `Number()`
 * before the payload is rebuilt for the HMAC, so without that regex every
 * numeric spelling that `Number()` folds to the same value — `05`, `+5`, `5e0`,
 * `0x5`, `" 5"` — re-derives the *exact* signed payload and verifies. It is the
 * only thing standing between numeric normalisation and a token that is valid
 * under a spelling the rest of the system rejects. Named here because it was
 * caught by attack in implementation review, having read as decoration.
 */
const APPOINTMENT_TOKEN_VERSION = 'a1';

function secret(): string {
  const value = readEnv('BOOKING_DRAFT_SECRET');
  if (!value) throw new Error('BOOKING_DRAFT_SECRET is not configured');
  return value;
}

async function hmacKey(usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    usages,
  );
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function fromHex(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export type DraftToken = {
  draftId: string;
  token: string;
};

/** Mint a fresh draft id and its signed token. */
export async function issueDraftToken(now: Date = new Date()): Promise<DraftToken> {
  const draftId = crypto.randomUUID();
  const issuedAt = now.getTime();
  const key = await hmacKey(['sign']);
  const payload = `${draftId}.${issuedAt}`;
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return { draftId, token: `${TOKEN_VERSION}.${payload}.${toHex(sig)}` };
}

/**
 * Verify a token and return its draft id, or null if the signature is bad,
 * the format is wrong, or it has aged out. Signature comparison goes through
 * `crypto.subtle.verify`, which is constant time.
 */
export async function verifyDraftToken(
  token: unknown,
  now: Date = new Date(),
): Promise<string | null> {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 4) return null;

  const [version, draftId, issuedAtRaw, sigHex] = parts;
  if (version !== TOKEN_VERSION) return null;

  const issuedAt = Number(issuedAtRaw);
  if (!Number.isFinite(issuedAt)) return null;

  const ageMs = now.getTime() - issuedAt;
  if (ageMs < 0 || ageMs > DRAFT_TOKEN_TTL_HOURS * 60 * 60 * 1000) return null;

  const sig = fromHex(sigHex);
  if (!sig) return null;

  const key = await hmacKey(['verify']);
  const ok = await crypto.subtle.verify(
    'HMAC',
    key,
    sig as unknown as BufferSource,
    new TextEncoder().encode(`${draftId}.${issuedAt}`),
  );
  return ok ? draftId : null;
}

// ---------------------------------------------------------------------------
// Appointment upload tokens (BK-34a)
//
// The phone-booking half of the upload funnel. A web booking mints a draft and
// claims its files at commit; a phone booking already HAS the appointment, so
// there is nothing to claim and the authorization has to name the row instead.
//
// It carries a `draftId` as well, and that is not vestigial: files still land
// under the existing `bookings/<draftId>/` prefix, which is what lets
// `parseUploadPathname`, `buildUploadPathname` and the island's upload logic
// stay exactly as they are. The row is written with BOTH columns set — which
// also means the orphan-cleanup cron (`appointment_id IS NULL`) never sees it,
// and the admin file proxy (claimed rows only) serves it from birth.
// ---------------------------------------------------------------------------

export type AppointmentUploadToken = {
  appointmentId: number;
  draftId: string;
  token: string;
};

/** What a verified appointment token yields. Never contains anything from the request. */
export type AppointmentUploadClaims = {
  appointmentId: number;
  draftId: string;
};

/**
 * Mint a signed, appointment-scoped upload token.
 *
 * The `draftId` is fresh per token, so a re-issued link writes under a new
 * prefix. That is deliberate: it costs nothing (the caps count against
 * `appointment_id`, not the prefix — see the token route) and it means an old
 * link cannot overwrite a file uploaded through a newer one.
 */
export async function issueAppointmentUploadToken(
  appointmentId: number,
  now: Date = new Date(),
): Promise<AppointmentUploadToken> {
  if (!Number.isInteger(appointmentId) || appointmentId <= 0) {
    throw new Error('appointmentId must be a positive integer');
  }
  const draftId = crypto.randomUUID();
  const issuedAt = now.getTime();
  const key = await hmacKey(['sign']);
  const payload = `${appointmentId}.${draftId}.${issuedAt}`;
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return {
    appointmentId,
    draftId,
    token: `${APPOINTMENT_TOKEN_VERSION}.${payload}.${toHex(sig)}`,
  };
}

/**
 * Verify an appointment upload token, or null.
 *
 * Null for every failure — bad signature, wrong version, wrong arity, aged out,
 * malformed id. The caller renders ONE neutral page for all of them, on the
 * same reasoning the availability endpoint does not disclose *why* a slot is
 * unavailable.
 *
 * The appointment id comes out of the signed payload and nowhere else. A route
 * that took it from the URL alongside a token would be trusting the half of the
 * request that was not signed.
 */
export async function verifyAppointmentUploadToken(
  token: unknown,
  now: Date = new Date(),
): Promise<AppointmentUploadClaims | null> {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 5) return null;

  const [version, appointmentIdRaw, draftId, issuedAtRaw, sigHex] = parts;
  if (version !== APPOINTMENT_TOKEN_VERSION) return null;

  // LOAD-BEARING, NOT SHAPE-CHECKING. `Number` on '' is 0 and on ' 1' is 1, so
  // the shape is tested before the value — an id is digits, with no leading
  // zero, exactly as `parseAppointmentId` requires of a URL segment.
  //
  // Delete this and the token becomes malleable: `appointmentId` is
  // re-canonicalised through `Number()` two lines down and the payload is
  // rebuilt from the canonical form, so `05`, `+5`, `5e0`, `0x5` and `" 5"` all
  // reproduce the same signed string and VERIFY. See the fourth barrier in the
  // header comment.
  if (!/^[1-9][0-9]*$/.test(appointmentIdRaw)) return null;
  const appointmentId = Number(appointmentIdRaw);
  if (!Number.isSafeInteger(appointmentId)) return null;

  const issuedAt = Number(issuedAtRaw);
  if (!Number.isFinite(issuedAt)) return null;

  const ageMs = now.getTime() - issuedAt;
  if (ageMs < 0 || ageMs > APPOINTMENT_UPLOAD_TTL_HOURS * 60 * 60 * 1000) return null;

  const sig = fromHex(sigHex);
  if (!sig) return null;

  const key = await hmacKey(['verify']);
  const ok = await crypto.subtle.verify(
    'HMAC',
    key,
    sig as unknown as BufferSource,
    new TextEncoder().encode(`${appointmentId}.${draftId}.${issuedAt}`),
  );
  return ok ? { appointmentId, draftId } : null;
}
