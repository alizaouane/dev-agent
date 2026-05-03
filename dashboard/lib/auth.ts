import NextAuth, { type NextAuthConfig } from 'next-auth';
import GitHub from 'next-auth/providers/github';
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
      return true; // 204 means member
    } catch {
      // 404 means not a member; try next
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
    async signIn({ user, account }) {
      const username = (user as unknown as { login?: string }).login ?? user.name ?? '';
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
      // Expose the access token via session for server-side use only
      (session as unknown as { accessToken?: string }).accessToken = token.access_token as string;
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

declare module 'next-auth' {
  interface Session {
    user: {
      name?: string | null;
      email?: string | null;
      image?: string | null;
      username: string;
    };
    accessToken?: string;
  }
}
