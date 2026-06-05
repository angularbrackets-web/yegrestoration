import type { APIRoute } from 'astro';
import { createToken, COOKIE_NAME } from '../../../lib/auth';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const form = await request.formData();
  const password = (form.get('password') as string) ?? '';
  const expected = import.meta.env.ADMIN_PASSWORD;

  if (!expected || password !== expected) {
    return new Response(null, {
      status: 302,
      headers: { Location: '/admin/login?error=1' },
    });
  }

  const token = await createToken(password);
  const maxAge = 60 * 60 * 24 * 30;
  const cookie = `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;

  return new Response(null, {
    status: 302,
    headers: {
      Location: '/admin',
      'Set-Cookie': cookie,
    },
  });
};
