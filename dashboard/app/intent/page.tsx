import { PageHeader } from '@/components/ui/page-header';

/**
 * The dashboard's brainstorming surface has moved into Claude Code via
 * the /develop slash command. This page used to host a streaming PM chat;
 * it now redirects users to the new flow.
 */
export default function IntentPage() {
  return (
    <div>
      <PageHeader
        title="Brainstorm"
        descriptor="Brainstorming happens in Claude Code now."
      />
      <div className="max-w-2xl space-y-4 text-sm">
        <p>
          To start a new feature, run the <code>/develop</code> slash command in
          Claude Code from your consumer repo:
        </p>
        <pre className="rounded-md bg-muted p-4 font-mono text-xs">
          /develop &quot;your pitch in 1–3 sentences&quot;
        </pre>
        <p>
          To brainstorm from a proposal, go to{' '}
          <a className="underline" href="/proposals">/proposals</a> and click{' '}
          <strong>Brainstorm in Claude Code</strong> on the card. That copies the
          right command to your clipboard.
        </p>
        <p className="text-muted-foreground">
          The PM, spec brainstorm, and plan writing all happen in Claude Code via
          superpowers skills. Once <code>/develop</code> finishes, the issue
          appears on{' '}
          <a className="underline" href="/proposals">/proposals</a> at
          state:spec-ready, ready for you to approve and start implementation.
        </p>
      </div>
    </div>
  );
}
