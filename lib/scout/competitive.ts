import { XMLParser } from 'fast-xml-parser';
import type { Candidate } from './types';

type Config = { kind: 'competitive'; feeds: string[] };

type RssItem = { title?: string; link?: string; description?: string; pubDate?: string };
type RssChannel = { item?: RssItem | RssItem[] };
type RssRoot = { rss?: { channel?: RssChannel } };

export async function competitiveAdapter(config: Config): Promise<Candidate[]> {
  if (config.feeds.length === 0) return [];
  const parser = new XMLParser({ ignoreAttributes: false });
  const out: Candidate[] = [];
  for (const url of config.feeds) {
    let xml: string;
    try {
      const resp = await fetch(url);
      if (!resp.ok) {
        process.stderr.write(`competitive: ${url} HTTP ${resp.status}, skipping\n`);
        continue;
      }
      xml = await resp.text();
    } catch (err) {
      process.stderr.write(`competitive: ${url} fetch failed (${err instanceof Error ? err.message : String(err)}), skipping\n`);
      continue;
    }
    let parsed: RssRoot;
    try {
      parsed = parser.parse(xml) as RssRoot;
    } catch {
      process.stderr.write(`competitive: ${url} parse failed, skipping\n`);
      continue;
    }
    const items = parsed.rss?.channel?.item ?? [];
    const list = Array.isArray(items) ? items : [items];
    for (const item of list.slice(0, 20)) {
      if (!item.title) continue;
      out.push({
        source: 'competitive',
        title: `competitor signal: ${item.title.slice(0, 80)}`,
        body: `From: ${url}\n${item.description?.slice(0, 200) ?? ''}\nPublished: ${item.pubDate ?? 'unknown'}`,
        evidence_url: item.link ?? null,
        severity_hint: 'low',
        novelty_score: 0.5,
      });
    }
  }
  return out;
}
