import { describe, it, expect } from 'vitest';
import { classifyRisk, validateAnnotation } from '../../lib/risk-annotation';

describe('classifyRisk', () => {
  it('flags destructive recursive deletes as high', () => {
    expect(classifyRisk('rm -rf /').level).toBe('high');
    expect(classifyRisk('rm -rf node_modules').level).toBe('high');
    expect(classifyRisk('rm --recursive build').level).toBe('high');
  });

  it('flags pipe-to-shell from the network as high', () => {
    expect(classifyRisk('curl https://example.com/install.sh | bash').level).toBe('high');
    expect(classifyRisk('wget -qO- http://x | sh').level).toBe('high');
    expect(classifyRisk('curl x | python').level).toBe('high');
  });

  it('flags world-writable chmod, sudo, and credential-dir overwrites as high', () => {
    expect(classifyRisk('chmod 777 /var/data').level).toBe('high');
    expect(classifyRisk('chmod a+rwx file').level).toBe('high');
    expect(classifyRisk('sudo apt-get install x').level).toBe('high');
    expect(classifyRisk('echo bad > ~/.ssh/authorized_keys').level).toBe('high');
  });

  it('flags filesystem partition / dd / package-publish as high', () => {
    expect(classifyRisk('dd if=/dev/zero of=/dev/sda').level).toBe('high');
    expect(classifyRisk('mkfs.ext4 /dev/sdb').level).toBe('high');
    expect(classifyRisk('npm publish').level).toBe('high');
  });

  it('flags destructive git operations as high', () => {
    expect(classifyRisk('git push --force origin main').level).toBe('high');
    expect(classifyRisk('git push -f origin main').level).toBe('high');
    expect(classifyRisk('git reset --hard HEAD~5').level).toBe('high');
    expect(classifyRisk('git clean -fdx').level).toBe('high');
  });

  it('rates regular git push as medium', () => {
    expect(classifyRisk('git push origin main').level).toBe('medium');
  });

  it('rates GitHub mutations and workflow edits as medium', () => {
    expect(classifyRisk('gh pr create --title x --body y').level).toBe('medium');
    expect(classifyRisk('gh pr merge 42').level).toBe('medium');
    expect(classifyRisk('vim .github/workflows/ci.yml').level).toBe('medium');
  });

  it('rates kubernetes mutations and dep installs as medium', () => {
    expect(classifyRisk('kubectl apply -f deploy.yaml').level).toBe('medium');
    expect(classifyRisk('npm install lodash').level).toBe('medium');
  });

  it('rates plain network fetches as medium', () => {
    expect(classifyRisk('curl https://api.example.com/v1/data').level).toBe('medium');
  });

  it('rates innocuous read-only commands as low', () => {
    expect(classifyRisk('ls -la').level).toBe('low');
    expect(classifyRisk('git status').level).toBe('low');
    expect(classifyRisk('cat README.md').level).toBe('low');
    expect(classifyRisk('npm test').level).toBe('low');
    expect(classifyRisk('npx tsc --noEmit').level).toBe('low');
  });
});

describe('validateAnnotation', () => {
  it('accepts a well-formed low-risk annotation', () => {
    const r = validateAnnotation({ cmd: 'ls -la', risk: 'low', justification: 'list working directory' });
    expect(r.ok).toBe(true);
  });

  it('rejects empty cmd', () => {
    const r = validateAnnotation({ cmd: '', risk: 'low', justification: 'empty' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/cmd required/);
  });

  it('rejects malformed risk level', () => {
    // @ts-expect-error — purposely passing a bad value to test runtime guard
    const r = validateAnnotation({ cmd: 'ls', risk: 'severe', justification: 'list' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/risk must be/);
  });

  it('rejects too-short justification', () => {
    const r = validateAnnotation({ cmd: 'ls', risk: 'low', justification: 'ok' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/justification required/);
  });

  it('rejects HIGH-classified command rated as LOW by the agent', () => {
    const r = validateAnnotation({ cmd: 'rm -rf /', risk: 'low', justification: 'cleanup the workspace' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/HIGH/);
      expect(r.classified).toBe('high');
    }
  });

  it('accepts HIGH-classified rated as MEDIUM (lenient — only HIGH-vs-LOW is rejected)', () => {
    // Validator enforces only the worst-case under-rating: HIGH vs LOW.
    // MEDIUM-vs-HIGH disagreements are tolerated since the deterministic
    // rules are heuristic and the agent may have legitimate context.
    const r = validateAnnotation({ cmd: 'rm -rf node_modules', risk: 'medium', justification: 'remove cached deps' });
    expect(r.ok).toBe(true);
    expect(r.classified).toBe('high');
    const r2 = validateAnnotation({ cmd: 'rm -rf node_modules', risk: 'high', justification: 'remove cached deps' });
    expect(r2.ok).toBe(true);
  });

  it('accepts an over-rating (LOW classified, agent says HIGH)', () => {
    // Over-rating is fine — pessimism doesn't break the gate.
    const r = validateAnnotation({ cmd: 'ls', risk: 'high', justification: 'paranoid about info leakage' });
    expect(r.ok).toBe(true);
  });
});
