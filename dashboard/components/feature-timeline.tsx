import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { TimelineEvent, TimelineEventKind } from '@/lib/feature-timeline';

type Props = {
  events: TimelineEvent[];
};

/**
 * Vertical per-feature timeline. Renders the lifecycle from intent →
 * phases → session-log entries → human comments, newest-first. Each
 * row shows a kind-specific icon, the human-readable timestamp, the
 * title, and (collapsed by default) a description.
 *
 * The component is a pure server-rendered list — no client state. If
 * we add filtering or expand-all-rows controls later, we'll move to a
 * client component; for v1 the static render is plenty.
 */
export function FeatureTimeline({ events }: Props) {
  if (events.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Timeline</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            No timeline events yet. Once the issue gets a comment or a phase runs, events will
            appear here.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Timeline</CardTitle>
      </CardHeader>
      <CardContent>
        <ol className="flex flex-col gap-0">
          {events.map((e, i) => (
            <TimelineRow key={`${e.timestamp}-${i}`} event={e} isLast={i === events.length - 1} />
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

function TimelineRow({ event, isLast }: { event: TimelineEvent; isLast: boolean }) {
  const meta = event.meta ?? {};
  return (
    <li className="relative flex gap-3 pb-4">
      {/* Vertical guide line: skip on the last row so the line doesn't dangle. */}
      {!isLast ? (
        <span
          aria-hidden
          className="absolute left-[15px] top-8 bottom-0 w-px bg-border"
        />
      ) : null}

      {/* Icon disc. */}
      <div
        aria-hidden
        className={`relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs ${kindColor(
          event.kind,
          String(meta.outcome ?? meta.status ?? ''),
        )}`}
      >
        {kindGlyph(event.kind)}
      </div>

      <div className="min-w-0 flex-1 pt-0.5">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-sm font-medium text-foreground">{event.title}</span>
          {event.kind === 'phase' && meta.phase ? (
            <Badge variant="secondary" className="text-xs">
              {String(meta.phase)}
            </Badge>
          ) : null}
          <time
            dateTime={event.timestamp}
            className="text-xs text-muted-foreground"
            suppressHydrationWarning
          >
            {formatTimestamp(event.timestamp)}
          </time>
        </div>
        {event.description ? (
          <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
            {truncate(event.description, 600)}
          </p>
        ) : null}
        {event.url ? (
          <a
            className="mt-1 inline-block text-xs underline text-muted-foreground hover:text-foreground"
            href={event.url}
            rel="noreferrer noopener"
            target="_blank"
          >
            View on GitHub
          </a>
        ) : null}
      </div>
    </li>
  );
}

function kindGlyph(kind: TimelineEventKind): string {
  switch (kind) {
    case 'intent':
      return '✨';
    case 'phase':
      return '🤖';
    case 'pr_link':
      return '🔀';
    case 'session_log':
      return '📓';
    case 'comment':
      return '💬';
    default:
      return '·';
  }
}

/**
 * Tailwind-tinted background per kind. For `phase` events, also dim the
 * disc when the phase didn't succeed (so the eye picks up failures
 * without reading the row).
 */
function kindColor(kind: TimelineEventKind, statusOrOutcome: string): string {
  const failureLike =
    statusOrOutcome === 'blocked' ||
    statusOrOutcome === 'aborted' ||
    statusOrOutcome === 'rolled_back' ||
    statusOrOutcome.toLowerCase().startsWith('failed');
  if (kind === 'phase' && failureLike) {
    return 'bg-destructive/15 text-destructive';
  }
  switch (kind) {
    case 'intent':
      return 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400';
    case 'phase':
      return 'bg-blue-500/15 text-blue-600 dark:text-blue-400';
    case 'pr_link':
      return 'bg-purple-500/15 text-purple-600 dark:text-purple-400';
    case 'session_log':
      return 'bg-amber-500/15 text-amber-600 dark:text-amber-400';
    case 'comment':
      return 'bg-muted text-muted-foreground';
    default:
      return 'bg-muted text-muted-foreground';
  }
}

function formatTimestamp(iso: string): string {
  // Render a stable UTC representation; client locale formatting would
  // hydration-mismatch since the server doesn't know the user's TZ.
  return iso.replace('T', ' ').replace(/:\d{2}\.\d+Z$/, ' UTC').replace(/Z$/, ' UTC');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + '…';
}
