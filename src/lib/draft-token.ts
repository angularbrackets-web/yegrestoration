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

/**
 * The office's own upload token (BK-40).
 *
 * The admin page mints TWO tokens now: `a1` goes into the link the office
 * texts, `a2` drives the uploader embedded on the page itself. They authorize
 * exactly the same thing — writes under one appointment's prefix — and differ
 * only in what they say about *who is uploading*, which is what
 * `appointment_files.source` records.
 *
 * **THE ORIGIN IS INSIDE THE SIGNATURE, AND IT HAS TO BE.** The version tag is
 * NOT part of the signed payload — look at `issueAppointmentUploadToken`: the
 * HMAC covers `<id>.<draftId>.<issuedAt>` and the version is prepended
 * afterwards. So if `a1` and `a2` shared a payload shape, rewriting the leading
 * `a1.` of a customer's link token to `a2.` would produce a token that still
 * verifies, and every photo a customer sent would be recorded as having come
 * from the office. Provenance nobody can forge is the entire point of the
 * column; provenance derived from an unsigned byte is worse than none, because
 * the office would believe it.
 *
 * The same three barriers as above therefore apply between `a1` and `a2`:
 *
 *   1. **Different version tag** — `a1` vs `a2`.
 *   2. **Different arity** — 5 parts vs 6, the origin being the extra segment.
 *   3. **Different signed payload** — `<id>.<draftId>.<issuedAt>` vs
 *      `<id>.<draftId>.<issuedAt>.<origin>`.
 *
 * `a1` is deliberately left byte-identical to what BK-34a shipped. Links minted
 * before this change are live in customers' messages for up to 72 hours, and
 * changing the shape of `a1` would kill every one of them.
 */
const OFFICE_TOKEN_VERSION = 'a2';

/**
 * Who put the file there.
 *
 * `link` is the customer, through the URL the office texted them. `office` is
 * an agent using the uploader on the admin page, typically because the photos
 * arrived by email. There is no third value and no "unknown" here — a row whose
 * provenance is genuinely unknown stores NULL, which is every row written
 * before migration 006.
 */
export type UploadOrigin = 'link' | 'office';

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
  origin: UploadOrigin;
  token: string;
  /**
   * The instant this token stops verifying (BK-37).
   *
   * Returned rather than recomputed by the caller, because
   * `verifyAppointmentUploadToken` applies `APPOINTMENT_UPLOAD_TTL_HOURS` to
   * `issuedAt` a few lines down and a second application of the same constant
   * somewhere else is a place the two can drift. The admin page states this
   * date to the office; if it ever disagreed with the verifier, the office
   * would be telling a customer a deadline the system does not honour.
   */
  expiresAt: Date;
};

/** What a verified appointment token yields. Never contains anything from the request. */
export type AppointmentUploadClaims = {
  appointmentId: number;
  draftId: string;
  /** From inside the signature. See `OFFICE_TOKEN_VERSION`. */
  origin: UploadOrigin;
};

/**
 * Mint a signed, appointment-scoped upload token.
 *
 * The `draftId` is fresh per token, so a re-issued link writes under a new
 * prefix. That is deliberate: it costs nothing (the caps count against
 * `appointment_id`, not the prefix — see the token route) and it means an old
 * link cannot overwrite a file uploaded through a newer one.
 *
 * `origin` defaults to `'link'`, which keeps the customer's token — the one
 * that travels in a text message — byte-identical to what BK-34a shipped. The
 * office's `'office'` token is a different version, arity and signed payload;
 * see `OFFICE_TOKEN_VERSION` for why all three, and why the origin must be
 * inside the signature rather than beside it.
 */
export async function issueAppointmentUploadToken(
  appointmentId: number,
  now: Date = new Date(),
  origin: UploadOrigin = 'link',
): Promise<AppointmentUploadToken> {
  if (!Number.isInteger(appointmentId) || appointmentId <= 0) {
    throw new Error('appointmentId must be a positive integer');
  }
  const draftId = crypto.randomUUID();
  const issuedAt = now.getTime();
  const key = await hmacKey(['sign']);

  const isOffice = origin === 'office';
  const payload = isOffice
    ? `${appointmentId}.${draftId}.${issuedAt}.${origin}`
    : `${appointmentId}.${draftId}.${issuedAt}`;
  const version = isOffice ? OFFICE_TOKEN_VERSION : APPOINTMENT_TOKEN_VERSION;

  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return {
    appointmentId,
    draftId,
    origin,
    token: `${version}.${payload}.${toHex(sig)}`,
    expiresAt: new Date(issuedAt + APPOINTMENT_UPLOAD_TTL_HOURS * 60 * 60 * 1000),
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
 * request that was not signed. **The same is now true of the origin** (BK-40):
 * it is a segment of the signed payload, not a byte beside it, so it cannot be
 * flipped by editing the token.
 *
 * Two shapes are accepted, and the arity decides which BEFORE anything else is
 * read — 5 parts is the customer's link token, 6 is the office's. Neither can
 * be turned into the other by rewriting the version tag, because the version is
 * not signed and the payloads differ.
 */
export async function verifyAppointmentUploadToken(
  token: unknown,
  now: Date = new Date(),
): Promise<AppointmentUploadClaims | null> {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 5 && parts.length !== 6) return null;

  const isOffice = parts.length === 6;
  const [version, appointmentIdRaw, draftId, issuedAtRaw] = parts;
  const sigHex = parts[parts.length - 1];

  // Arity and version must agree. Without this, a 6-part token tagged `a1`
  // would take the office branch on arity alone.
  if (version !== (isOffice ? OFFICE_TOKEN_VERSION : APPOINTMENT_TOKEN_VERSION)) return null;

  // The origin is read from the token only to be VERIFIED against the
  // signature below — never trusted as read. An unrecognised value is rejected
  // outright rather than defaulted, so a future third origin cannot be
  // silently downgraded to one of these two.
  const origin: UploadOrigin = isOffice ? 'office' : 'link';
  if (isOffice && parts[4] !== 'office') return null;

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

  // Rebuilt from the CANONICAL values, exactly as minted. The office arm
  // carries the origin, which is what makes an `a1` signature fail to verify as
  // an `a2` token even if every other check were bypassed.
  const signed = isOffice
    ? `${appointmentId}.${draftId}.${issuedAt}.${origin}`
    : `${appointmentId}.${draftId}.${issuedAt}`;

  const key = await hmacKey(['verify']);
  const ok = await crypto.subtle.verify(
    'HMAC',
    key,
    sig as unknown as BufferSource,
    new TextEncoder().encode(signed),
  );
  return ok ? { appointmentId, draftId, origin } : null;
}
