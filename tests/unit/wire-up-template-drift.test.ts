import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Drift detector: the dashboard embeds the contents of
 * `examples/web-app-template/` as TypeScript constants in
 * `dashboard/lib/wire-up-template.ts` (so the wire-up server action is
 * self-contained inside the Vercel deployment, which doesn't ship the
 * `examples/` directory).
 *
 * This test fails if the on-disk template diverges from the embedded
 * copy — forcing whoever updates the template to also update the
 * embedded copy. Without this, a friendly "I improved the template"
 * commit would silently leave new consumers wired up with stale config.
 */
describe('wire-up-template embedded copy', () => {
  const root = resolve(__dirname, '../..');
  const tplDir = resolve(root, 'examples/web-app-template');
  const embedded = readFileSync(
    resolve(root, 'dashboard/lib/wire-up-template.ts'),
    'utf8',
  );

  it('.dev-agent.yml on disk matches the embedded TEMPLATE_DEV_AGENT_YML', () => {
    const onDisk = readFileSync(resolve(tplDir, '.dev-agent.yml'), 'utf8');
    expect(embedded).toContain(onDisk);
  });

  it('workflow yml on disk matches the embedded TEMPLATE_WORKFLOW_YML', () => {
    const onDisk = readFileSync(
      resolve(tplDir, '.github/workflows/dev-agent.yml'),
      'utf8',
    );
    // The embedded source is a TS template literal, so two characters get
    // escaped in the on-disk source code:
    //   `${{` → `\${{` (would otherwise interpolate)
    //   `` ` `` → `` \` `` (would otherwise close the template literal)
    // Reverse both escapes before substring-matching.
    const normalized = embedded
      .replace(/\\\$\{\{/g, '${{')
      .replace(/\\`/g, '`');
    expect(normalized).toContain(onDisk);
  });

  it('pm.md on disk matches the embedded TEMPLATE_PM_MD', () => {
    const onDisk = readFileSync(resolve(tplDir, '.dev-agent/pm.md'), 'utf8');
    const normalized = embedded.replace(/\\`/g, '`');
    expect(normalized).toContain(onDisk);
  });

  it('bug-scout workflow on disk matches the embedded TEMPLATE_BUG_SCOUT_WORKFLOW_YML', () => {
    const onDisk = readFileSync(
      resolve(tplDir, '.github/workflows/dev-agent-bug-scout.yml'),
      'utf8',
    );
    // Same TS-template-literal escapes as the main workflow:
    //   `${{` → `\${{` (would otherwise interpolate)
    //   `` ` `` → `` \` `` (would otherwise close the literal)
    //   `\$0.30-1.00` → `\\$0.30-1.00` (the dollar sign is escaped to
    //     prevent template-literal interpolation of `$N`)
    const normalized = embedded
      .replace(/\\\$\{\{/g, '${{')
      .replace(/\\`/g, '`')
      .replace(/\\\$/g, '$');
    expect(normalized).toContain(onDisk);
  });
});
