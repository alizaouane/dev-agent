import { describe, it, expect, beforeEach } from 'vitest';
import { isUsernameAllowed, isOrgAllowed, parseAllowlist, authConfig } from '@/lib/auth';

describe('parseAllowlist', () => {
  it('parses a simple CSV', () => {
    expect(parseAllowlist('alice,bob,charlie')).toEqual(['alice', 'bob', 'charlie']);
  });
  it('trims whitespace', () => {
    expect(parseAllowlist(' alice , bob,  charlie ')).toEqual(['alice', 'bob', 'charlie']);
  });
  it('drops empty entries', () => {
    expect(parseAllowlist('alice,,bob,')).toEqual(['alice', 'bob']);
  });
  it('returns empty array for empty input', () => {
    expect(parseAllowlist('')).toEqual([]);
    expect(parseAllowlist(undefined)).toEqual([]);
  });
});

describe('isUsernameAllowed', () => {
  beforeEach(() => {
    process.env.ALLOWED_GH_USERNAMES = 'alizaouane,teammate1';
  });
  it('returns true for allowlisted user', () => {
    expect(isUsernameAllowed('alizaouane')).toBe(true);
    expect(isUsernameAllowed('teammate1')).toBe(true);
  });
  it('returns false for non-allowlisted user', () => {
    expect(isUsernameAllowed('stranger')).toBe(false);
  });
  it('is case-insensitive on the username', () => {
    expect(isUsernameAllowed('AliZaouane')).toBe(true);
  });
  it('returns false when env unset', () => {
    delete process.env.ALLOWED_GH_USERNAMES;
    expect(isUsernameAllowed('alizaouane')).toBe(false);
  });
});

describe('isOrgAllowed', () => {
  beforeEach(() => {
    process.env.ALLOWED_GH_ORGS = 'qualiency,otherorg';
  });
  it('returns true for an allowed org', () => {
    expect(isOrgAllowed('qualiency')).toBe(true);
  });
  it('returns false for a non-allowed org', () => {
    expect(isOrgAllowed('strange-org')).toBe(false);
  });
  it('is case-insensitive', () => {
    expect(isOrgAllowed('QUALIENCY')).toBe(true);
  });
});

describe('session callback', () => {
  it('does NOT expose accessToken on the returned session (would leak to browser)', async () => {
    const sessionCallback = authConfig.callbacks?.session;
    expect(sessionCallback).toBeDefined();
    const result = await sessionCallback!({
      session: { user: { name: 'Ali', email: 'a@b.com', image: null }, expires: new Date(Date.now() + 86400000).toISOString() },
      token: { access_token: 'gho_supersecret', username: 'alizaouane' },
    } as unknown as Parameters<NonNullable<typeof sessionCallback>>[0]);
    expect((result as unknown as Record<string, unknown>).accessToken).toBeUndefined();
    // The username should still be exposed on user (that's safe — it's public)
    expect((result as unknown as { user: { username: string } }).user.username).toBe('alizaouane');
  });
});
