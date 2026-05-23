#!/usr/bin/env tsx
/**
 * Offline export of dev-agent audit anchors (Pillar: audit / overrides).
 *
 * Walks a repo's PR comments via the GitHub REST API, extracts the
 * `<!-- dev-agent:event:b64 ... -->` audit anchors using the pure helpers
 * in `lib/events-scrape.ts`, and writes one JSON line per decoded event
 * to `<out-dir>/<pr-number>.jsonl`. PRs with no anchors get no file.
 *
 * The dashboard's Overrides panel reads the same anchors directly — this
 * CLI exists for ad-hoc operator exports (eval pipelines, archival,
 * spreadsheet imports, etc.) and is opt-in / manually invoked.
 *
 * Runnable via `npm run events-scrape -- --out .dev-agent/events`.
 *
 * Env:
 *   - GH_TOKEN / GITHUB_TOKEN  (required)
 *   - GITHUB_REPOSITORY        (required, "owner/repo")
 *
 * Flags:
 *   --out <dir>            output directory (default `.dev-agent/events`)
 *   --window-days <N>      look-back window in days (default 90)
 */

import { Octokit } from '@octokit/rest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { extractAnchors, decodeAnchor } from '../events-scrape';

function parseArgs(argv: string[]): { outDir: string; windowDays: number } {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out' && argv[i + 1]) {
      args.out = argv[i + 1];
      i++;
    } else if (argv[i] === '--window-days' && argv[i + 1]) {
      args.windowDays = argv[i + 1];
      i++;
    }
  }
  const windowDays = args.windowDays ? Number.parseInt(args.windowDays, 10) : 90;
  if (!Number.isInteger(windowDays) || windowDays <= 0) {
    throw new Error('--window-days must be a positive integer');
  }
  return {
    outDir: args.out ?? '.dev-agent/events',
    windowDays,
  };
}

async function main(): Promise<void> {
  const { outDir, windowDays } = parseArgs(process.argv.slice(2));
  const ghToken = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!ghToken) throw new Error('GH_TOKEN / GITHUB_TOKEN required');
  const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? '').split('/');
  if (!owner || !repo) throw new Error('GITHUB_REPOSITORY required (owner/repo)');

  const octokit = new Octokit({ auth: ghToken });
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

  // pulls.list (state: 'all') with sort:updated/direction:desc lets us
  // stop pagination as soon as we cross the lookback boundary — the API
  // doesn't expose a server-side `since` for pulls, but the sort order
  // makes early-stop equivalent.
  const recentPrs: Array<{ number: number; updated_at: string }> = [];
  for await (const page of octokit.paginate.iterator(octokit.pulls.list, {
    owner,
    repo,
    state: 'all',
    sort: 'updated',
    direction: 'desc',
    per_page: 100,
  })) {
    let stop = false;
    for (const pr of page.data as Array<{ number: number; updated_at: string }>) {
      if (pr.updated_at < since) { stop = true; break; }
      recentPrs.push(pr);
    }
    if (stop) break;
  }

  fs.mkdirSync(outDir, { recursive: true });
  let totalWritten = 0;

  for (const pr of recentPrs) {
    const comments = await octokit.paginate(octokit.issues.listComments, {
      owner,
      repo,
      issue_number: pr.number,
      per_page: 100,
    });
    // Trust only github-actions[bot] as the audit-source — any other
    // commenter could otherwise inject a forged anchor and corrupt the
    // exported audit trail.
    const trusted = comments.filter(
      (c) => (c as { user?: { login?: string } | null }).user?.login === 'github-actions[bot]',
    );
    const out: string[] = [];
    for (const c of trusted) {
      const body = c.body ?? '';
      for (const b64 of extractAnchors(body)) {
        const event = decodeAnchor(b64);
        if (!event) continue;
        // Write the raw event — downstream tooling decides whether to narrow.
        out.push(JSON.stringify(event));
      }
    }
    if (out.length === 0) continue;
    const file = path.join(outDir, `${pr.number}.jsonl`);
    fs.writeFileSync(file, out.join('\n') + '\n');
    totalWritten += out.length;
    console.log(`wrote ${out.length} events to ${file}`);
  }
  console.log(`done — ${totalWritten} events across ${recentPrs.length} PRs scanned`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
