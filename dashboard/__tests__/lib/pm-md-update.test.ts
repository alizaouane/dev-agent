import { describe, it, expect } from 'vitest';
import { extractPmMdUpdate } from '@/lib/pm-md-update';

describe('extractPmMdUpdate', () => {
  it('extracts the fenced markdown block under "## pm.md update"', () => {
    const msg = [
      'Sounds good. Here is the agreed scope.',
      '',
      '## Agreed scope',
      '',
      'Add a refund button.',
      '',
      '## pm.md update',
      '',
      '```markdown',
      '---',
      'goals:',
      '  q2: "ship onboarding"',
      'last_updated: "2026-05-04"',
      '---',
      '',
      '# Notes',
      '',
      'Updated body.',
      '```',
    ].join('\n');
    const out = extractPmMdUpdate(msg);
    expect(out).not.toBeNull();
    expect(out).toContain('q2: "ship onboarding"');
    expect(out).toContain('# Notes');
  });

  it('returns null when there is no pm.md update section', () => {
    expect(extractPmMdUpdate('Just some text. ## Agreed scope\n\nbuild it.')).toBeNull();
  });

  it('returns null when the section exists but the fenced block is missing', () => {
    expect(
      extractPmMdUpdate('## pm.md update\n\nForgot to attach the file.'),
    ).toBeNull();
  });

  it('returns null when the fence tag is not "markdown"', () => {
    const msg = [
      '## pm.md update',
      '',
      '```yaml',
      'goals:',
      '  q2: "ship"',
      '```',
    ].join('\n');
    expect(extractPmMdUpdate(msg)).toBeNull();
  });

  it('handles 4-tick fences for nested code blocks (PM sometimes does this)', () => {
    const msg = [
      '## pm.md update',
      '',
      '````markdown',
      '---',
      'goals:',
      '  q2: "ship"',
      '---',
      '',
      '# Notes',
      '',
      'Has a nested ``` block inside the body.',
      '````',
    ].join('\n');
    const out = extractPmMdUpdate(msg);
    expect(out).not.toBeNull();
    expect(out).toContain('Has a nested');
  });

  it('is case-insensitive on the heading', () => {
    const msg = [
      '## PM.md update',
      '',
      '```markdown',
      'content',
      '```',
    ].join('\n');
    expect(extractPmMdUpdate(msg)).toBe('content');
  });

  it('returns null for an empty fenced block', () => {
    const msg = ['## pm.md update', '', '```markdown', '```'].join('\n');
    expect(extractPmMdUpdate(msg)).toBeNull();
  });
});
