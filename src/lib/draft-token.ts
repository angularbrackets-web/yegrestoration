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

import { DRAFT_TOKEN_TTL_HOURS } from './booking-config';
import { readEnv } from './env';

const TOKEN_VERSION = 'v1';

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
