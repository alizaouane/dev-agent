import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { ParsedTelemetry } from '@/lib/telemetry';

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
}: {
  repo: string;
  issue: IssueShape;
  telemetry: ParsedTelemetry[];
  prUrl: string | null;
}) {
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-3">
            <CardTitle>{issue.title}</CardTitle>
            <Badge variant="secondary">{issue.state.replace('state:', '')}</Badge>
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
    </div>
  );
}
