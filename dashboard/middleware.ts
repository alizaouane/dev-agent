import { auth } from '@/lib/auth';

export default auth((req) => {
  const isAuthRoute = req.nextUrl.pathname.startsWith('/auth/');
  const isApiAuthRoute = req.nextUrl.pathname.startsWith('/api/auth/');
  if (isAuthRoute || isApiAuthRoute) return;
  if (!req.auth) {
    const url = new URL('/auth/signin', req.url);
    return Response.redirect(url);
  }
});

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
