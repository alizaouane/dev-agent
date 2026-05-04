import 'server-only';

import { tool } from 'ai';
import { z } from 'zod';
import type { Octokit } from '@octokit/rest';

import { fetchPipeline, type FeatureItem } from './pipeline';
import { runAllScouts, type Proposal } from './scout';
import type { RepoInfo } from './repos';

/**
 * Read-only Octokit-backed tools the PM agent can call mid-conversation
 * to inspect the consumer's repo. Lets the PM ground its judgment in
 * actual code/state instead of asking the user to type out repo facts.
 *
 * Every tool runs server-side under the user's existing GitHub auth (the
 * `octokit` instance is the same one the chat route already holds). No
 * new permissions, no sandboxed runtime. Tools are READ-ONLY by
 * construction — none of them call mutating Octokit endpoints.
 *
 * Errors are returned as `{ error: "..." }` rather than thrown so the
 * model can recover gracefully (try a different path, fall back to a
 * different tool) instead of crashing the chat turn.
 */

/** Hard cap on bytes returned per `read_file` so a binary or very long
 * file can't blow out the conversation context. 50 KB is enough for
 * a typical README, source file, or markdown doc. */
const MAX_FILE_BYTES = 50_000;

/** Hard cap on directory entries returned by `list_directory`. */
const MAX_DIR_ENTRIES = 200;

/** Hard cap on commits returned by `read_recent_commits`. */
const MAX_COMMITS = 50;

/** Hard cap on code-search hits per call. */
const MAX_SEARCH_HITS = 20;

export type PmToolContext = {
  octokit: Octokit;
  /** The repo being chatted about — `owner/name`. */
  repo: RepoInfo;
  /** Resolved default branch — read from `repo.default_branch`. */
};

/**
 * Build the tool object expected by `streamText({tools})`. The factory
 * shape (rather than a static export) lets us close over the per-request
 * Octokit + RepoInfo without leaking them as global state.
 */
export function buildPmTools(ctx: PmToolContext) {
  return {
    read_file: tool({
      description:
        'Read a file from the repo on its default branch. Use this to look at READMEs, source files, configuration, or any markdown the user references. If the file is large, pass `range` to read only a slice.',
      inputSchema: z.object({
        path: z.string().describe('Repo-relative path, e.g. "README.md" or "src/lib/auth.ts".'),
        range: z
          .object({
            start: z.number().int().min(1).describe('1-indexed start line, inclusive.'),
            end: z.number().int().min(1).describe('1-indexed end line, inclusive.'),
          })
          .optional()
          .describe('Optional inclusive line range. Omit to read the whole file.'),
      }),
      execute: async ({ path, range }) => {
        try {
          const resp = await ctx.octokit.repos.getContent({
            owner: ctx.repo.owner,
            repo: ctx.repo.name,
            path,
            ref: ctx.repo.default_branch,
          });
          const data = resp.data as { type?: string; content?: string; encoding?: string };
          if (data.type !== 'file' || !data.content || data.encoding !== 'base64') {
            return { error: `path "${path}" is not a regular file (got type=${data.type ?? 'unknown'}).` };
          }
          const decoded = Buffer.from(data.content, 'base64').toString('utf8');
          const totalLines = decoded.split('\n').length;
          if (range) {
            const lines = decoded.split('\n');
            const slice = lines.slice(range.start - 1, range.end).join('\n');
            const bytes = Buffer.byteLength(slice, 'utf8');
            if (bytes > MAX_FILE_BYTES) {
              return {
                error: `range too large (${bytes} bytes). Try a smaller window.`,
              };
            }
            return { path, range, content: slice, total_lines: totalLines };
          }
          if (Buffer.byteLength(decoded, 'utf8') > MAX_FILE_BYTES) {
            return {
              error: `file is ${Buffer.byteLength(decoded, 'utf8')} bytes (cap ${MAX_FILE_BYTES}). Use \`range\` to read a slice.`,
              total_lines: totalLines,
            };
          }
          return { path, content: decoded, total_lines: totalLines };
        } catch (err) {
          const status = (err as { status?: number }).status;
          if (status === 404) return { error: `not found: ${path}` };
          return { error: `read_file failed: ${(err as Error).message}` };
        }
      },
    }),

    list_directory: tool({
      description:
        'List the contents of a directory in the repo. Use this to discover the project layout. Defaults to the repo root.',
      inputSchema: z.object({
        path: z
          .string()
          .default('')
          .describe('Repo-relative directory path. Empty string means repo root.'),
      }),
      execute: async ({ path }) => {
        try {
          const resp = await ctx.octokit.repos.getContent({
            owner: ctx.repo.owner,
            repo: ctx.repo.name,
            path: path || '',
            ref: ctx.repo.default_branch,
          });
          if (!Array.isArray(resp.data)) {
            return { error: `path "${path || '/'}" is not a directory.` };
          }
          const entries = resp.data.slice(0, MAX_DIR_ENTRIES).map((e) => ({
            name: e.name,
            path: e.path,
            type: e.type, // "file" | "dir" | "submodule" | "symlink"
            size: e.size,
          }));
          return {
            path: path || '/',
            entries,
            truncated: resp.data.length > MAX_DIR_ENTRIES,
          };
        } catch (err) {
          const status = (err as { status?: number }).status;
          if (status === 404) return { error: `directory not found: ${path || '/'}` };
          return { error: `list_directory failed: ${(err as Error).message}` };
        }
      },
    }),

    search_code: tool({
      description:
        'Search for a string across the repo using GitHub code search. Use this when you need to find where a function, label, or pattern is referenced.',
      inputSchema: z.object({
        query: z.string().min(1).describe('Search query (string or simple GitHub-search expression).'),
        path_glob: z
          .string()
          .optional()
          .describe('Optional path filter (e.g. "lib/", "src/auth/").'),
      }),
      execute: async ({ query, path_glob }) => {
        try {
          // Scope to the repo regardless of what the model passes.
          const scoped = `${query} repo:${ctx.repo.owner}/${ctx.repo.name}${path_glob ? ` path:${path_glob}` : ''}`;
          const resp = await ctx.octokit.search.code({ q: scoped, per_page: MAX_SEARCH_HITS });
          const hits = resp.data.items.slice(0, MAX_SEARCH_HITS).map((it) => ({
            path: it.path,
            html_url: it.html_url,
            name: it.name,
          }));
          return {
            query: scoped,
            total: resp.data.total_count,
            hits,
            truncated: resp.data.total_count > hits.length,
          };
        } catch (err) {
          // Code-search is rate-limited (10 req/min for authenticated users).
          // 422 also fires if the repo is empty or the query is malformed.
          return { error: `search_code failed: ${(err as Error).message}` };
        }
      },
    }),

    read_recent_commits: tool({
      description:
        'Read the most recent commits on the default branch. Use this to see what the team has been working on lately.',
      inputSchema: z.object({
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_COMMITS)
          .default(10)
          .describe(`How many recent commits to fetch (max ${MAX_COMMITS}).`),
      }),
      execute: async ({ limit }) => {
        try {
          const resp = await ctx.octokit.repos.listCommits({
            owner: ctx.repo.owner,
            repo: ctx.repo.name,
            sha: ctx.repo.default_branch,
            per_page: Math.min(limit, MAX_COMMITS),
          });
          const commits = resp.data.map((c) => ({
            sha: c.sha.slice(0, 7),
            message: (c.commit.message ?? '').split('\n')[0], // first line only
            author: c.commit.author?.name ?? c.author?.login ?? 'unknown',
            date: c.commit.author?.date ?? null,
          }));
          return { commits };
        } catch (err) {
          return { error: `read_recent_commits failed: ${(err as Error).message}` };
        }
      },
    }),

    read_pipeline: tool({
      description:
        'List issues currently in flight (state:scoping / spec-ready / implementing / pr-review / etc.). Use this to know what work is already underway before pitching new work.',
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const items = await fetchPipeline(ctx.octokit, [ctx.repo]);
          return {
            pipeline: items.map((i: FeatureItem) => ({
              issue_number: i.issue_number,
              title: i.title,
              state: i.state,
              age_days: Math.floor(i.age_seconds / 86_400),
              blockers: i.blockers,
              html_url: i.html_url,
            })),
          };
        } catch (err) {
          return { error: `read_pipeline failed: ${(err as Error).message}` };
        }
      },
    }),

    read_proposals: tool({
      description:
        'List the current /proposals queue for THIS repo (the wider "stuff that\'s stuck" picture beyond in-flight). Includes unfinished plan items, pending specs, bug-scout findings, and other scout signals.',
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const all = await runAllScouts(ctx.octokit, [ctx.repo]);
          const proposals = all.map((p: Proposal) => ({
            id: p.id,
            source: p.source,
            title: p.title,
            description: p.description,
            url: p.url,
          }));
          return { proposals };
        } catch (err) {
          return { error: `read_proposals failed: ${(err as Error).message}` };
        }
      },
    }),
  } as const;
}

export type PmTools = ReturnType<typeof buildPmTools>;
