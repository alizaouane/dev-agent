'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';

/**
 * Hand-off button on `/proposals` (and the home + per-repo pages).
 * Replaces the old "Discuss with PM" link that pre-loaded `/intent`
 * with prefill text. The PM brainstorming flow now lives in Claude
 * Code via `/develop`, so this button copies the slash command to the
 * clipboard — the user pastes it into Claude Code and the agent picks
 * up from the GitHub issue.
 *
 * The copied command includes `--repo owner/name` because `/proposals`
 * lists proposals across every wired-up repo. Without it, `/develop`
 * would resolve the target repo from the user's `cwd` and could seed
 * brainstorming from the wrong issue number (issues are repo-scoped on
 * GitHub).
 */
export function ProposalBrainstormButton({
  issueNumber,
  repo,
}: {
  issueNumber: number;
  repo: string;
}) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const command = `/develop --from-issue ${issueNumber} --repo ${repo}`;

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(command);
      setStatus('copied');
      // Reset after 2s so a second click feels responsive instead of
      // looking stuck on "Copied!".
      setTimeout(() => setStatus('idle'), 2000);
    } catch (err) {
      // Permission denied / insecure context / unsupported browser.
      // Surface a fallback so the user can still grab the command —
      // silently leaving the button in its idle state would look broken.
      console.warn('[ProposalBrainstormButton] clipboard copy failed:', err);
      setStatus('failed');
    }
  }

  if (status === 'failed') {
    // Fallback: show the command inline so the user can select-and-copy
    // manually. One-shot — no auto-reset, the user needs time to read it.
    return (
      <span className="inline-flex items-center gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-1 text-xs">
        <span className="font-medium">Copy failed — select manually:</span>
        <code className="font-mono">{command}</code>
        <button
          type="button"
          onClick={() => setStatus('idle')}
          className="text-muted-foreground underline"
        >
          Reset
        </button>
      </span>
    );
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={onCopy}
      title={`Copies ${command} to clipboard. Paste into Claude Code.`}
    >
      {status === 'copied' ? 'Copied!' : 'Brainstorm in Claude Code'}
    </Button>
  );
}
