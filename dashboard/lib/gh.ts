import 'server-only';

import { Octokit } from '@octokit/rest';

import { auth, getServerAccessToken } from './auth';

/**
 * Thrown when a server-side caller tries to act on behalf of a user but no
 * authenticated session is present (no cookie, expired/invalid token, or
 * missing `access_token` claim).
 *
 * Route handlers / Server Actions should catch this and translate to a 401
 * (or trigger a re-auth flow). Server Components should let it propagate;
 * the auth middleware redirects unauthenticated requests before render, so
 * hitting this in an RSC indicates a real bug.
 */
export class UnauthorizedError extends Error {
  constructor(message = 'Not authenticated') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

/**
 * Server-only: build an Octokit client authenticated with the current user's
 * GitHub OAuth token. The token is read from the encrypted JWT session cookie
 * (see {@link getServerAccessToken} in `./auth`) and is never exposed to the
 * browser.
 *
 * @throws UnauthorizedError if no valid session cookie / access token is found
 */
export async function getOctokit(): Promise<Octokit> {
  const accessToken = await getServerAccessToken();
  if (!accessToken) throw new UnauthorizedError();
  return new Octokit({ auth: accessToken });
}

/**
 * Server-only: return the signed-in user's GitHub login (username).
 *
 * Reads the username from the NextAuth session (which is safe to expose —
 * the username is intentionally part of the public session shape, unlike
 * the access token). Uses {@link auth} rather than the JWT cookie directly
 * so callers see the same view of the session as the rest of the app.
 *
 * @throws UnauthorizedError if no session is present or username is missing
 */
export async function getCurrentUsername(): Promise<string> {
  const session = await auth();
  const username = session?.user?.username;
  if (!username) throw new UnauthorizedError();
  return username;
}
