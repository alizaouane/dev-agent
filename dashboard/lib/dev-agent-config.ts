import 'server-only';

import yaml from 'js-yaml';
import { z } from 'zod';
import type { Octokit } from '@octokit/rest';

/**
 * Read the consumer's `.dev-agent.yml` to learn where it stores specs and
 * plans. The wire-up template ships these defaulted under `docs/specs` /
 * `docs/plans`, but a consumer can override them in their config — and
 * many third-party repos already wired up don't follow our convention,
 * so the scouts have to honor the per-repo paths.
 *
 * Best-effort: any failure (404, malformed YAML, schema mismatch) returns
 * the defaults rather than throwing. The dashboard's `/proposals` page is
 * a glanceable surface; one repo's misconfig shouldn't blank the page.
 */

export const DEFAULT_SPECS_DIR = 'docs/specs';
export const DEFAULT_PLANS_DIR = 'docs/plans';

/**
 * Schema for the subset of `.dev-agent.yml` the dashboard reads. We only
 * validate the fields we use; everything else is preserved untouched in
 * the consumer's repo. `passthrough` on the artifacts object so adding new
 * artifact paths in the engine doesn't make this loader reject the file.
 */
const devAgentConfigSchema = z
  .object({
    artifacts: z
      .object({
        specs_dir: z.string().min(1).optional(),
        plans_dir: z.string().min(1).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type DevAgentConfig = {
  specs_dir: string;
  plans_dir: string;
};

const DEFAULT_CONFIG: DevAgentConfig = {
  specs_dir: DEFAULT_SPECS_DIR,
  plans_dir: DEFAULT_PLANS_DIR,
};

/**
 * Strip a leading `./`, trim, and drop any trailing `/`. Octokit's
 * `getContent` accepts either form, but normalizing here means tests
 * comparing against the param see the canonical shape.
 */
function normalizePath(p: string | undefined, fallback: string): string {
  if (!p) return fallback;
  const trimmed = p.trim().replace(/^\.\//, '').replace(/\/+$/, '');
  return trimmed.length > 0 ? trimmed : fallback;
}

/**
 * Load and parse `.dev-agent.yml` from the repo's default branch. Returns
 * the resolved `{ specs_dir, plans_dir }` with fallbacks applied. Never
 * throws — see file-level doc for why.
 */
export async function loadDevAgentConfig(
  octokit: Octokit,
  owner: string,
  repo: string,
  default_branch: string,
): Promise<DevAgentConfig> {
  let raw: string;
  try {
    const resp = await octokit.repos.getContent({
      owner,
      repo,
      path: '.dev-agent.yml',
      ref: default_branch,
    });
    const data = resp.data as { content?: string; encoding?: string; type?: string };
    if (data.type !== 'file' || !data.content || data.encoding !== 'base64') {
      return DEFAULT_CONFIG;
    }
    raw = Buffer.from(data.content, 'base64').toString('utf8');
  } catch {
    // 404, rate limit, transient — degrade to defaults.
    return DEFAULT_CONFIG;
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch {
    return DEFAULT_CONFIG;
  }

  const result = devAgentConfigSchema.safeParse(parsed ?? {});
  if (!result.success) return DEFAULT_CONFIG;

  return {
    specs_dir: normalizePath(result.data.artifacts?.specs_dir, DEFAULT_SPECS_DIR),
    plans_dir: normalizePath(result.data.artifacts?.plans_dir, DEFAULT_PLANS_DIR),
  };
}
