import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Octokit } from '@octokit/rest';
import { readArtifactsConfig } from '@/lib/dashboard/read-artifacts-config';

const getContent = vi.fn();
const octokit = { repos: { getContent } } as unknown as Octokit;

/** A getContent response carrying `yaml` as the file's text. */
function file(yaml: string) {
  return { data: { content: Buffer.from(yaml, 'utf8').toString('base64') } };
}

/** An Octokit-shaped error with a status. */
function httpError(status: number): Error & { status: number } {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

beforeEach(() => vi.clearAllMocks());

describe('readArtifactsConfig', () => {
  it('reads the configured directory', async () => {
    getContent.mockResolvedValue(file('artifacts:\n  stories_dir: docs/work/stories\n'));
    expect(await readArtifactsConfig(octokit, 'o', 'r', 'main')).toEqual({
      storiesDir: 'docs/work/stories',
      unreadable: false,
    });
  });

  it('defaults when the config has no stories_dir', async () => {
    getContent.mockResolvedValue(file('artifacts:\n  specs_dir: docs/specs\n'));
    expect(await readArtifactsConfig(octokit, 'o', 'r', 'main')).toEqual({
      storiesDir: 'docs/stories',
      unreadable: false,
    });
  });

  it('defaults, readably, when there is no config at all', async () => {
    getContent.mockRejectedValue(httpError(404));
    expect(await readArtifactsConfig(octokit, 'o', 'r', 'main')).toEqual({
      storiesDir: 'docs/stories',
      unreadable: false,
    });
  });

  it('marks itself unreadable when the read fails for any other reason', async () => {
    // A rate-limited read is not a repo configured for docs/stories. Folding
    // the two together is how an outage becomes a decision nobody made.
    getContent.mockRejectedValue(httpError(403));
    expect(await readArtifactsConfig(octokit, 'o', 'r', 'main')).toEqual({
      storiesDir: 'docs/stories',
      unreadable: true,
    });
  });

  it('marks itself unreadable when the config cannot be parsed', async () => {
    getContent.mockResolvedValue(file('artifacts: [this is not\n  a mapping\n'));
    expect((await readArtifactsConfig(octokit, 'o', 'r', 'main')).unreadable).toBe(true);
  });

  it('marks itself unreadable when stories_dir is present but unusable', async () => {
    // We could read it and cannot honour it. Listing docs/stories anyway
    // would report a directory the operator did not configure as if they had.
    getContent.mockResolvedValue(file('artifacts:\n  stories_dir: 17\n'));
    const result = await readArtifactsConfig(octokit, 'o', 'r', 'main');
    expect(result).toEqual({ storiesDir: 'docs/stories', unreadable: true });
  });

  it('strips a trailing slash so path prefixes compose', async () => {
    getContent.mockResolvedValue(file('artifacts:\n  stories_dir: docs/stories/\n'));
    expect((await readArtifactsConfig(octokit, 'o', 'r', 'main')).storiesDir).toBe('docs/stories');
  });
});
