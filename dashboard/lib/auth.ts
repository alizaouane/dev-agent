import NextAuth, { type NextAuthConfig } from 'next-auth';
import GitHub from 'next-auth/providers/github';
import { getToken } from 'next-auth/jwt';
import { headers } from 'next/headers';
import { Octokit } from '@octokit/rest';

export function parseAllowlist(csv: string | undefined): string[] {
  if (!csv) return [];
  return csv.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

export function isUsernameAllowed(username: string): boolean {
  const allowed = parseAllowlist(process.env.ALLOWED_GH_USERNAMES);
  return allowed.some((u) => u.toLowerCase() === username.toLowerCase());
}

export function isOrgAllowed(org: string): boolean {
  const allowed = parseAllowlist(process.env.ALLOWED_GH_ORGS);
  return allowed.some((o) => o.toLowerCase() === org.toLowerCase());
}

async function isUserMemberOfAnyAllowedOrg(token: string, username: string): Promise<boolean> {
  const allowedOrgs = parseAllowlist(process.env.ALLOWED_GH_ORGS);
  if (allowedOrgs.length === 0) return false;
  const octokit = new Octokit({ auth: token });
  for (const org of allowedOrgs) {
    try {
      await octokit.orgs.checkMembershipForUser({ org, username });
      return true;
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 404) continue; // genuine "not a member" — try next org
      // 401/403/5xx — log and re-throw so signIn surfaces a different error
      console.error(`org check failed for ${org}/${username}: ${status}`, e);
      throw e;
    }
  }
  return false;
}

export const authConfig: NextAuthConfig = {
  providers: [
    GitHub({
      clientId: process.env.GITHUB_OAUTH_CLIENT_ID,
      clientSecret: process.env.GITHUB_OAUTH_CLIENT_SECRET,
      authorization: {
        params: {
          scope: 'read:user user:email repo workflow read:org',
        },
      },
    }),
  ],
  callbacks: {
    async signIn({ account, profile }) {
      const username = (profile as { login?: string } | undefined)?.login ?? '';
      if (!username) return '/auth/error?reason=missing_login';
      if (isUsernameAllowed(username)) return true;
      if (account?.access_token && (await isUserMemberOfAnyAllowedOrg(account.access_token, username))) {
        return true;
      }
      return '/auth/error?reason=not_allowlisted';
    },
    async jwt({ token, account, profile }) {
      if (account) {
        token.access_token = account.access_token;
        token.username = (profile as { login?: string } | undefined)?.login;
      }
      return token;
    },
    async session({ session, token }) {
      session.user = {
        ...session.user,
        username: (token.username as string) ?? '',
      };
      return session;
    },
  },
  pages: {
    signIn: '/auth/signin',
    error: '/auth/error',
  },
  session: { strategy: 'jwt', maxAge: 30 * 24 * 60 * 60 }, // 30 days
};

export const { handlers, signIn, signOut, auth } = NextAuth(authConfig);

/**
 * Server-only: read the GitHub OAuth access token from the encrypted JWT
 * session cookie. Returns `undefined` if no session cookie is present or the
 * token has been decrypted but lacks `access_token`.
 *
 * The access token is intentionally NOT exposed on the Session object (see T7),
 * so it never reaches the browser via /api/auth/session. Server-side callers
 * must read it directly from the cookie via this helper.
 *
 * Implementation note: this mirrors how NextAuth v5's own `auth()` adapts
 * Next.js' `headers()` into a `Request` so that `@auth/core`'s `getToken()`
 * can locate and decrypt the session cookie. `getToken()` handles cookie-name
 * detection (`authjs.session-token` / `__Secure-authjs.session-token`) and
 * uses the cookie name as the JWE salt.
 */
export async function getServerAccessToken(): Promise<string | undefined> {
  const secret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error('AUTH_SECRET or NEXTAUTH_SECRET must be set');

  const h = await headers();
  // Build a minimal Request that carries the incoming cookies, the same way
  // NextAuth v5 does in node_modules/next-auth/lib/index.js (getSession).
  const req = new Request('http://localhost', {
    headers: { cookie: h.get('cookie') ?? '' },
  });

  // `secureCookie` toggles between `authjs.session-token` (dev/HTTP) and
  // `__Secure-authjs.session-token` (prod/HTTPS). NEXTAUTH_URL is the
  // canonical signal — fall back to NODE_ENV in case it is unset.
  const authUrl = process.env.NEXTAUTH_URL ?? process.env.AUTH_URL;
  const secureCookie = authUrl
    ? authUrl.startsWith('https://')
    : process.env.NODE_ENV === 'production';

  const token = await getToken({ req, secret, secureCookie });
  const accessToken = (token as { access_token?: unknown } | null)?.access_token;
  return typeof accessToken === 'string' ? accessToken : undefined;
}

declare module 'next-auth' {
  interface Session {
    user: {
      name?: string | null;
      email?: string | null;
      image?: string | null;
      username: string;
    };
    // accessToken intentionally NOT exposed on the Session — read server-side
    // via getServerAccessToken() (lib/auth.ts).
  }
}
