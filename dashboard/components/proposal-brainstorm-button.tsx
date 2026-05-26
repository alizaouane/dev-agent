'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';

/**
 * Hand-off button on `/proposals`. Replaces the old "Discuss with PM"
 * link that pre-loaded `/intent` with prefill text. The PM brainstorming
 * flow now lives in Claude Code via `/develop`, so this button just
 * copies the slash command to the clipboard — the user pastes it into
 * Claude Code and the agent picks up from the GitHub issue.
 */
export function ProposalBrainstormButton({ issueNumber }: { issueNumber: number }) {
  const [copied, setCopied] = useState(false);
  const command = `/develop --from-issue ${issueNumber}`;

  async function onCopy() {
    await navigator.clipboard.writeText(command);
    setCopied(true);
    // Reset after 2s so a second click feels responsive instead of
    // looking stuck on "Copied!".
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={onCopy}
      title={`Copies ${command} to clipboard. Paste into Claude Code.`}
    >
      {copied ? 'Copied!' : 'Brainstorm in Claude Code'}
    </Button>
  );
}
