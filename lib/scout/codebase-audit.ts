import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Candidate } from './types';

type Config = {
  kind: 'codebase_audit';
  pitfalls_path: string;
  max_age_days: number;
  _scan_root?: string;
};

const MARKER_RE = /\b(TODO|FIXME|HACK)\b:?\s*(.*)$/;

function* walkFiles(root: string): Generator<string> {
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      yield* walkFiles(full);
    } else if (entry.isFile() && /\.(ts|tsx|js|jsx)$/.test(entry.name)) {
      yield full;
    }
  }
}

export async function codebaseAuditAdapter(config: Config): Promise<Candidate[]> {
  const root = config._scan_root ?? process.cwd();
  const out: Candidate[] = [];
  for (const file of walkFiles(root)) {
    let content: string;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(MARKER_RE);
      if (m) {
        const marker = m[1];
        const text = m[2].trim();
        if (text.length === 0) continue;
        out.push({
          source: 'codebase_audit',
          title: `${marker}: ${text.slice(0, 80)}`,
          body: `${file}:${i + 1}\n${lines[i].trim()}`,
          evidence_url: null,
          severity_hint: marker === 'FIXME' ? 'high' : 'medium',
          novelty_score: 0.6,
        });
      }
    }
  }
  return out;
}
