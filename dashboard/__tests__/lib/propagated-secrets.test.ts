import { describe, it, expect } from 'vitest';
import {
  PROPAGATED_SECRETS,
  resolveSecrets,
  summarizePush,
  validatePostgresUrl,
} from '@/lib/propagated-secrets';

const GOOD_URL = 'postgresql://postgres.abcdef:s3cret@aws-0-eu-west-2.pooler.supabase.com:6543/postgres';

describe('validatePostgresUrl', () => {
  it('accepts a pooler connection string', () => {
    expect(validatePostgresUrl(GOOD_URL)).toBeNull();
  });

  it('accepts the postgres:// spelling too', () => {
    expect(validatePostgresUrl('postgres://u:p@host:5432/db')).toBeNull();
  });

  it('rejects a value with no password, which is how the gate goes quiet', () => {
    // schema-drift cannot connect, treats the secret as absent, and passes.
    // A pushed-but-unusable value is worse than an unset one, because the
    // operator believes it is configured.
    const problem = validatePostgresUrl('postgresql://postgres@host:5432/postgres');
    expect(problem).toContain('no password');
    expect(problem).toContain('report success');
  });

  it('rejects a project URL pasted in place of a connection string', () => {
    // The likeliest paste error: the Supabase dashboard shows several URLs and
    // only one of them is the database connection string.
    expect(validatePostgresUrl('https://abcdef.supabase.co')).toContain('expected postgresql');
  });

  it('rejects text that is not a URL at all', () => {
    expect(validatePostgresUrl('paste it here')).toContain('not a URL');
  });

  it('rejects a connection string with no host', () => {
    expect(validatePostgresUrl('postgresql:///postgres')).not.toBeNull();
  });
});

describe('resolveSecrets', () => {
  it('resolves a configured, valid secret to a pushable value', () => {
    const out = resolveSecrets({ ANTHROPIC_API_KEY: 'sk-ant-x', SUPABASE_DB_URL: GOOD_URL });
    expect(out.every((s) => s.value !== undefined)).toBe(true);
    expect(out.map((s) => s.name)).toEqual(PROPAGATED_SECRETS.map((s) => s.name));
  });

  it('skips an unset secret and says which env var to set', () => {
    const out = resolveSecrets({});
    expect(out[0].value).toBeUndefined();
    expect(out[0].skipReason).toContain('ANTHROPIC_API_KEY');
  });

  it('treats a whitespace-only value as unset', () => {
    expect(resolveSecrets({ ANTHROPIC_API_KEY: '   ' })[0].value).toBeUndefined();
  });

  it('refuses to push a configured but unusable value, and says why', () => {
    const out = resolveSecrets({ SUPABASE_DB_URL: 'https://abcdef.supabase.co' });
    const supa = out.find((s) => s.name === 'SUPABASE_DB_URL')!;
    expect(supa.value).toBeUndefined();
    expect(supa.skipReason).toContain('unusable');
  });

  it('does not let one broken secret block a valid one', () => {
    const out = resolveSecrets({ ANTHROPIC_API_KEY: 'sk-ant-x', SUPABASE_DB_URL: 'nonsense' });
    expect(out.find((s) => s.name === 'ANTHROPIC_API_KEY')!.value).toBe('sk-ant-x');
    expect(out.find((s) => s.name === 'SUPABASE_DB_URL')!.value).toBeUndefined();
  });

  it('never carries a value into the skip reason', () => {
    // The reason is rendered in the dashboard, so a secret must not travel in
    // it. The value has to actually FAIL validation, or this exercises the
    // pushable path and cannot catch a leak: it carries a password and a
    // scheme the validator rejects.
    const out = resolveSecrets({ SUPABASE_DB_URL: 'mysql://user:hunter2@db.internal:3306/app' });
    const supa = out.find((x) => x.name === 'SUPABASE_DB_URL')!;
    expect(supa.value).toBeUndefined();
    expect(supa.skipReason).toBeDefined();
    expect(supa.skipReason).not.toContain('hunter2');
    expect(supa.skipReason).not.toContain('db.internal');
  });
});

describe('summarizePush', () => {
  it('names what landed', () => {
    expect(summarizePush(['ANTHROPIC_API_KEY'], [])).toContain('Pushed ANTHROPIC_API_KEY');
  });

  it('names what did not, so a skip is never silent', () => {
    const text = summarizePush([], [{ name: 'SUPABASE_DB_URL', skipReason: 'not set' }]);
    expect(text).toContain('SUPABASE_DB_URL skipped: not set');
  });

  it('says plainly when nothing is configured', () => {
    expect(summarizePush([], [])).toContain('No secrets are configured');
  });
});
