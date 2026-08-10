export const COOKIE_NAME = 'yeg_admin';

/**
 * The only admin paths reachable without a session: the login page and the two
 * form endpoints behind it. Stored unslashed; `isPublicAdminPath` accepts
 * either form.
 */
const PUBLIC_ADMIN_PATHS = new Set(['/admin/login', '/api/admin/login', '/api/admin/logout']);

/**
 * Is `pathname` one of the public admin paths, in either slash form?
 *
 * `astro.config.mjs` sets `trailingSlash: 'always'`, so production 308s every
 * request to the slashed form before the middleware ever sees it. A raw
 * `Set.has(pathname)` therefore missed `/admin/login/`, redirected it to
 * `/admin/login`, which 308'd back — an infinite loop that made the whole
 * `/admin` surface unreachable from ~2026-07-04 until BK-07.
 *
 * The normalization is exactly one trailing slash, then an exact match. Nothing
 * looser: this function is the gate, so anything it wrongly calls public is
 * served without a session. `/admin/login-x`, `/admin/login//` and
 * `/api/admin/login/extra` are all protected, and an unrecognized path always
 * falls through to the authenticated branch.
 *
 * Pure and env-free so `scripts/verify-booking-admin.ts` can import it.
 */
export function isPublicAdminPath(pathname: string): boolean {
  if (typeof pathname !== 'string') return false;
  const normalized =
    pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  return PUBLIC_ADMIN_PATHS.has(normalized);
}

/** Where an unauthenticated page request is sent. Slashed — the unslashed form 308s. */
export const ADMIN_LOGIN_PATH = '/admin/login/';

async function deriveToken(password: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode('yeg-admin-v1'));
  return Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function createToken(password: string): Promise<string> {
  return deriveToken(password);
}

export async function isValidToken(token: string, password: string): Promise<boolean> {
  const expected = await deriveToken(password);
  return token === expected;
}
