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
 * Three outcomes, kept apart on purpose. An absent config — the file is
 * missing, or present but empty, or `artifacts` is present but null/unset —
 * is a repo that has not been wired for stories, and the default applies
 * with `unreadable: false`. A read that failed for any other reason (a
 * non-404 HTTP error, YAML that fails to parse) is not an absent config:
 * reporting it as one would list the default directory and call the result
 * complete. A config we could read but not honour — the top-level document
 * or `artifacts` is a scalar or array rather than a mapping, or
 * `stories_dir` is present but not a usable non-empty string — is the same
 * failure wearing a different hat: the operator named something and we
 * would be silently listing a different directory instead. All three
 * unreadable-shaped cases return the default with `unreadable: true`.
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

  // An empty file parses to `undefined` and names no directory — the same
  // fact as an absent config. A document that parsed but isn't a mapping
  // (a bare scalar, or a top-level sequence) has no `.artifacts` to read;
  // optional chaining would silently read `undefined` off it the same way
  // it reads `undefined` off a missing key, collapsing "can't be honoured"
  // into "wasn't configured". Arrays are typeof 'object' in JS, so they need
  // their own check alongside the scalar one.
  if (parsed === undefined || parsed === null) {
    return { storiesDir: DEFAULT_STORIES_DIR, unreadable: false };
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { storiesDir: DEFAULT_STORIES_DIR, unreadable: true };
  }

  const artifacts = (parsed as { artifacts?: unknown }).artifacts;
  if (artifacts === undefined || artifacts === null) {
    return { storiesDir: DEFAULT_STORIES_DIR, unreadable: false };
  }
  // Same reasoning as the top-level document: an array or scalar `artifacts`
  // has no `.stories_dir` to read, and that is not the same as it being unset.
  if (typeof artifacts !== 'object' || Array.isArray(artifacts)) {
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
