import { describe, it, expect } from 'vitest';
import {
  PROPAGATED_SECRETS,
  envSuffixForRepo,
  resolveSecrets,
  summarizePush,
  validatePostgresUrl,
} from '@/lib/propagated-secrets';

const GOOD_URL =
  'postgresql://postgres.sgtlkemmwmepcwmuqnei:s3cret@aws-0-eu-west-2.pooler.supabase.com:5432/postgres';
const OTHER_URL =
  'postgresql://postgres.ztkhjmotkantmectkugw:0ther@aws-0-eu-west-2.pooler.supabase.com:5432/postgres';

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

describe('envSuffixForRepo', () => {
  it('makes a repo name usable as an env var suffix', () => {
    expect(envSuffixForRepo('caliente-booking-app')).toBe('CALIENTE_BOOKING_APP');
    expect(envSuffixForRepo('whatsapp-console')).toBe('WHATSAPP_CONSOLE');
  });

  it('collapses any run of non-alphanumerics, so dots and spaces work too', () => {
    expect(envSuffixForRepo('my.repo name--v2')).toBe('MY_REPO_NAME_V2');
  });
});

describe('resolveSecrets', () => {
  /** Read every secret for one repo, defaulting to the booking app. */
  const forRepo = (env: Record<string, string | undefined>, repo = 'caliente-booking-app') =>
    resolveSecrets(env, repo);

  const DB_VAR = 'SUPABASE_DB_URL__CALIENTE_BOOKING_APP';

  it('resolves a configured, valid secret to a pushable value', () => {
    const out = forRepo({ ANTHROPIC_API_KEY: 'sk-ant-x', [DB_VAR]: GOOD_URL });
    expect(out.every((s) => s.value !== undefined)).toBe(true);
    expect(out.map((s) => s.name)).toEqual(PROPAGATED_SECRETS.map((s) => s.name));
  });

  it('skips an unset secret and says which env var to set', () => {
    const out = forRepo({});
    expect(out[0].value).toBeUndefined();
    expect(out[0].skipReason).toContain('ANTHROPIC_API_KEY');
  });

  it('treats a whitespace-only value as unset', () => {
    expect(forRepo({ ANTHROPIC_API_KEY: '   ' })[0].value).toBeUndefined();
  });

  it('refuses to push a configured but unusable value, and says why', () => {
    const out = forRepo({ [DB_VAR]: 'https://abcdef.supabase.co' });
    const supa = out.find((s) => s.name === 'SUPABASE_DB_URL')!;
    expect(supa.value).toBeUndefined();
    expect(supa.skipReason).toContain('unusable');
  });

  it('does not let one broken secret block a valid one', () => {
    const out = forRepo({ ANTHROPIC_API_KEY: 'sk-ant-x', [DB_VAR]: 'nonsense' });
    expect(out.find((s) => s.name === 'ANTHROPIC_API_KEY')!.value).toBe('sk-ant-x');
    expect(out.find((s) => s.name === 'SUPABASE_DB_URL')!.value).toBeUndefined();
  });

  it('never carries a value into the skip reason', () => {
    // The reason is rendered in the dashboard, so a secret must not travel in
    // it. The value has to actually FAIL validation, or this exercises the
    // pushable path and cannot catch a leak: it carries a password and a
    // scheme the validator rejects.
    const out = forRepo({ [DB_VAR]: 'mysql://user:hunter2@db.internal:3306/app' });
    const supa = out.find((x) => x.name === 'SUPABASE_DB_URL')!;
    expect(supa.value).toBeUndefined();
    expect(supa.skipReason).toBeDefined();
    expect(supa.skipReason).not.toContain('hunter2');
    expect(supa.skipReason).not.toContain('db.internal');
  });

  it('never falls back to a shared database URL', () => {
    // Each repo has its own Supabase project. A bare SUPABASE_DB_URL used as a
    // fallback would point every repo's drift gate at one database — a gate
    // that then fails, or passes, for reasons unrelated to the repo it guards.
    const out = forRepo({ SUPABASE_DB_URL: GOOD_URL });
    const supa = out.find((s) => s.name === 'SUPABASE_DB_URL')!;
    expect(supa.value).toBeUndefined();
    expect(supa.skipReason).toContain(DB_VAR);
  });

  it('gives two repos two different database URLs', () => {
    const env = {
      SUPABASE_DB_URL__CALIENTE_BOOKING_APP: GOOD_URL,
      SUPABASE_DB_URL__WHATSAPP_CONSOLE: OTHER_URL,
    };
    const dbOf = (repo: string) =>
      resolveSecrets(env, repo).find((s) => s.name === 'SUPABASE_DB_URL')!.value;
    expect(dbOf('caliente-booking-app')).toBe(GOOD_URL);
    expect(dbOf('whatsapp-console')).toBe(OTHER_URL);
    expect(dbOf('caliente-gym')).toBeUndefined();
  });

  it('lets a shared secret be overridden for one repo without touching the rest', () => {
    const env = { ANTHROPIC_API_KEY: 'shared', ANTHROPIC_API_KEY__WHATSAPP_CONSOLE: 'special' };
    const keyOf = (repo: string) =>
      resolveSecrets(env, repo).find((s) => s.name === 'ANTHROPIC_API_KEY')!.value;
    expect(keyOf('whatsapp-console')).toBe('special');
    expect(keyOf('caliente-booking-app')).toBe('shared');
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
