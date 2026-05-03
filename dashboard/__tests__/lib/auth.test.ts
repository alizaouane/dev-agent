import { describe, it, expect, beforeEach } from 'vitest';
import { isUsernameAllowed, isOrgAllowed, parseAllowlist } from '@/lib/auth';

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
