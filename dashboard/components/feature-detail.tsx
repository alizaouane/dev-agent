import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Term } from '@/components/ui/term';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { ParsedTelemetry } from '@/lib/telemetry';
import { PILLAR_LABELS, type PillarId, type VerificationOutcome } from '@/lib/verification/types';
import type { TermKey } from '@/lib/glossary';

/** Map pillar IDs that have a glossary entry to their TermKey. */
const PILLAR_TERM: Partial<Record<PillarId, TermKey>> = {
  gate_b: 'gate-b',
  audit_p4: 'pillar-4',
  risk_p5: 'pillar-5',
};

type IssueShape = {
  number: number;
  title: string;
  body: string;
  html_url: string;
  state: string;
};

export function FeatureDetail({
  repo,
  issue,
  telemetry,
  prUrl,
  verification,
}: {
  repo: string;
  issue: IssueShape;
  telemetry: ParsedTelemetry[];
  prUrl: string | null;
  verification?: { outcomes: VerificationOutcome[]; expandedPillar: PillarId | null };
}) {
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-3">
            <CardTitle>{issue.title}</CardTitle>
            <Badge variant="secondary">
              {(() => {
                const stateLabel = issue.state.replace('state:', '');
                if (stateLabel === 'tier2-smoke') return <Term k="tier2-smoke" label={stateLabel} />;
                if (/^gate[\s-]?b$/i.test(stateLabel)) return <Term k="gate-b" label={stateLabel} />;
                return stateLabel;
              })()}
            </Badge>
            <span className="text-sm text-muted-foreground">
              {repo} #{issue.number}
            </span>
          </div>
        </CardHeader>
        <CardContent>
          <div className="prose prose-sm max-w-none whitespace-pre-wrap dark:prose-invert">
            {issue.body || <em>No description.</em>}
          </div>
          <div className="mt-3 flex flex-wrap gap-3 text-sm">
            <a className="underline" href={issue.html_url} rel="noreferrer noopener" target="_blank">
              Open in GitHub
            </a>
            {prUrl && (
              <a className="underline" href={prUrl} rel="noreferrer noopener" target="_blank">
                PR
              </a>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Telemetry</CardTitle>
        </CardHeader>
        <CardContent>
          {telemetry.length === 0 ? (
            <p className="text-sm text-muted-foreground">No phase telemetry yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Phase</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead className="text-right">Tokens (in/out)</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                  <TableHead>Mode</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {telemetry.map((t, i) => (
                  <TableRow key={i}>
                    <TableCell>{t.phase}</TableCell>
                    <TableCell>{t.model}</TableCell>
                    <TableCell className="text-right">
                      {t.tokens_in} / {t.tokens_out}
                    </TableCell>
                    <TableCell className="text-right">${t.cost_usd.toFixed(4)}</TableCell>
                    <TableCell>{t.mode}</TableCell>
                    <TableCell>{t.status}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {verification && verification.outcomes.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Verification</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-2">
              {verification.outcomes.map((o) => (
                <details
                  key={o.pillar}
                  open={verification.expandedPillar === o.pillar}
                  className="rounded border border-border p-3"
                >
                  <summary className="cursor-pointer text-sm font-medium">
                    {PILLAR_TERM[o.pillar]
                      ? <Term k={PILLAR_TERM[o.pillar]!} label={PILLAR_LABELS[o.pillar]} />
                      : PILLAR_LABELS[o.pillar]}{' '}
                    — {o.status} — {o.summary}
                  </summary>
                  <div className="mt-2 text-sm text-muted-foreground">
                    Ran at {o.ran_at}.{' '}
                    <a className="underline" href={o.details_url} target="_blank" rel="noreferrer noopener">
                      Open details
                    </a>
                    {typeof o.cost_usd === 'number' ? <> · cost ${o.cost_usd.toFixed(4)}</> : null}
                  </div>
                </details>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
