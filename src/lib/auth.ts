export const COOKIE_NAME = 'yeg_admin';

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
