import type { APIRoute } from 'astro';
import { COOKIE_NAME } from '../../../lib/auth';

export const prerender = false;

export const POST: APIRoute = async () => {
  const cookie = `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
  return new Response(null, {
    status: 302,
    headers: {
      Location: '/admin/login',
      'Set-Cookie': cookie,
    },
  });
};
