import { defineMiddleware } from 'astro:middleware';
import { ADMIN_LOGIN_PATH, COOKIE_NAME, isPublicAdminPath, isValidToken } from './lib/auth';

export const onRequest = defineMiddleware(async ({ url, cookies }, next) => {
  const { pathname } = url;

  const isAdminPage = pathname.startsWith('/admin');
  const isAdminApi = pathname.startsWith('/api/admin');

  if (!isAdminPage && !isAdminApi) return next();
  if (isPublicAdminPath(pathname)) return next();

  const token = cookies.get(COOKIE_NAME)?.value;
  const password = import.meta.env.ADMIN_PASSWORD;

  const authed = token && password && (await isValidToken(token, password).catch(() => false));

  if (!authed) {
    if (isAdminApi) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return Response.redirect(new URL(ADMIN_LOGIN_PATH, url));
  }

  return next();
});
