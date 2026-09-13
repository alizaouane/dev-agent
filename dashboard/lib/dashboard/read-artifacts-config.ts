import 'server-only';

import type { Octokit } from '@octokit/rest';
import { load } from 'js-yaml';

/**
 * Where stories live when the consumer has not said, or has said something
 * we cannot use. Matches `schema/defaults.yml`.
 */
const DEFAULT_STORIES_DIR = 'docs/stories';

/** What the consumer's config says about where artifacts live. */
export interface ArtifactsConfig {
  /** Repo-relative story directory, with no trailing slash. Always usable. */
  storiesDir: string;
  /**
   * True when this does not necessarily reflect the repo — the config could
   * not be read, could not be parsed, or named a value we cannot honour.
   * Callers surface it; nothing here decides what to do about it.
   */
  unreadable: boolean;
}

/**
 * Read `artifacts.stories_dir` from a consumer's `.dev-agent.yml`.
 *
 * Three outcomes, kept apart on purpose. An absent config is a repo that has
 * not been wired for stories, and the default applies. A read that failed for
 * any other reason is not an absent config: reporting it as one would list the
 * default directory and call the result complete. A config we could read but
 * not honour is the same failure wearing a different hat — the operator named
 * a directory and we would be listing a different one.
 *
 * @param octokit - Authenticated client for the consumer repo.
 * @param owner - Repo owner.
 * @param repo - Repo name.
 * @param ref - Branch to read the config from.
 * @returns The directory to list, and whether that answer is trustworthy.
 */
export async function readArtifactsConfig(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
): Promise<ArtifactsConfig> {
  let text: string;
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path: '.dev-agent.yml', ref });
    if (Array.isArray(data) || !('content' in data)) {
      return { storiesDir: DEFAULT_STORIES_DIR, unreadable: true };
    }
    text = Buffer.from(data.content, 'base64').toString('utf8');
  } catch (err) {
    const absent = (err as { status?: number }).status === 404;
    return { storiesDir: DEFAULT_STORIES_DIR, unreadable: !absent };
  }

  let parsed: unknown;
  try {
    parsed = load(text);
  } catch {
    return { storiesDir: DEFAULT_STORIES_DIR, unreadable: true };
  }

  const artifacts = (parsed as { artifacts?: unknown } | null)?.artifacts;
  if (artifacts === undefined || artifacts === null) {
    return { storiesDir: DEFAULT_STORIES_DIR, unreadable: false };
  }
  if (typeof artifacts !== 'object') {
    return { storiesDir: DEFAULT_STORIES_DIR, unreadable: true };
  }

  const raw = (artifacts as { stories_dir?: unknown }).stories_dir;
  // Absent is the documented default and reads cleanly. Present-but-unusable
  // is not: we would be listing a directory the operator did not name.
  if (raw === undefined) return { storiesDir: DEFAULT_STORIES_DIR, unreadable: false };
  if (typeof raw !== 'string') return { storiesDir: DEFAULT_STORIES_DIR, unreadable: true };

  const trimmed = raw.trim().replace(/\/+$/, '');
  if (trimmed === '') return { storiesDir: DEFAULT_STORIES_DIR, unreadable: true };
  return { storiesDir: trimmed, unreadable: false };
}
