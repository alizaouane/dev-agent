import Link from 'next/link';
import { PILLAR_LABELS, type VerificationOutcome, type PillarStatus } from '@/lib/verification/types';
import { Term } from '@/components/ui/term';

const STATUS_CLASSES: Record<PillarStatus, string> = {
  passed: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  advisory: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  blocked: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  failed: 'bg-destructive/15 text-destructive',
  not_run: 'bg-muted text-muted-foreground',
};

const STATUS_ICON: Record<PillarStatus, string> = {
  passed: '✓',
  advisory: '⚠',
  blocked: '⚠',
  failed: '✗',
  not_run: '·',
};

function deepLink(featureHref: string | undefined, pillar: string): string {
  if (!featureHref) return '#';
  const sep = featureHref.includes('?') ? '&' : '?';
  return `${featureHref}${sep}tab=verification&pillar=${encodeURIComponent(pillar)}`;
}

export function VerificationBadges({
  outcomes,
  featureHref,
}: {
  outcomes: VerificationOutcome[];
  /** When set, each chip links to /features/[issue]?...&tab=verification&pillar=<id> */
  featureHref?: string;
}) {
  if (outcomes.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {outcomes.map((o) => {
        const cls = `inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium ${STATUS_CLASSES[o.status]}`;
        const content = (
          <>
            <span aria-hidden>{STATUS_ICON[o.status]}</span>
            <span>
              {o.pillar === 'audit_p4' ? (
                <Term k="pillar-4" label={PILLAR_LABELS[o.pillar]} />
              ) : o.pillar === 'risk_p5' ? (
                <Term k="pillar-5" label={PILLAR_LABELS[o.pillar]} />
              ) : o.pillar === 'smoke_p7' ? (
                <Term k="tier2-smoke" label={PILLAR_LABELS[o.pillar]} />
              ) : (
                PILLAR_LABELS[o.pillar]
              )}
            </span>
            {o.summary ? <span className="opacity-80">— {o.summary}</span> : null}
          </>
        );
        return featureHref ? (
          <Link
            key={`${o.pillar}-${o.feature_id}`}
            href={deepLink(featureHref, o.pillar)}
            className={cls}
            title={`${PILLAR_LABELS[o.pillar]}: ${o.summary}`}
          >
            {content}
          </Link>
        ) : (
          <span key={`${o.pillar}-${o.feature_id}`} className={cls}>
            {content}
          </span>
        );
      })}
    </div>
  );
}
