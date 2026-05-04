'use client';

import { useState, useTransition } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, type UIMessage } from 'ai';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { RepoInfo } from '@/lib/repos';
import { approveAndStart } from '@/lib/actions';

/**
 * Streaming chat with the PM agent for in-browser idea intake.
 *
 * Flow:
 *   1. User picks a wired-up repo (drives the PM context — pm.md +
 *      pipeline are loaded server-side per-turn).
 *   2. User pitches an idea; PM streams a response via /api/pm-chat.
 *   3. Conversation continues until the PM emits an "## Agreed scope"
 *      section in its response.
 *   4. User clicks "Approve and start" — server action creates the
 *      issue with the agreed scope as body, dispatches the implement
 *      workflow, and redirects to the feature page.
 *
 * Conversation state is held entirely in the AI SDK's `messages` array
 * on the client. Reloading the page resets the chat — persistence
 * across sessions is intentionally Phase 3.2.5, not v1.
 */
export function PmChat({
  repos,
  initialInput = '',
  initialRepo = null,
}: {
  repos: RepoInfo[];
  initialInput?: string;
  initialRepo?: string | null;
}) {
  // Pre-select the repo from the URL if it's actually wired up — otherwise
  // fall back to the first wired repo. Defends against query-param tampering
  // and stale links to repos that have since been unwired.
  const initialRepoMatch =
    initialRepo && repos.some((r) => `${r.owner}/${r.name}` === initialRepo)
      ? initialRepo
      : null;
  const [repo, setRepo] = useState(
    initialRepoMatch ?? (repos[0] ? `${repos[0].owner}/${repos[0].name}` : ''),
  );
  const [input, setInput] = useState(initialInput);
  const [title, setTitle] = useState('');
  const [approveErr, setApproveErr] = useState<string | null>(null);
  const [approving, startApproveTransition] = useTransition();

  const transport = new DefaultChatTransport({
    api: '/api/pm-chat',
    // Forward the selected repo with every turn so the server can refresh
    // the PM's context (pm.md + pipeline) for that specific repo.
    body: () => ({ repo }),
  });

  const { messages, sendMessage, status, error } = useChat({
    transport,
  });

  const isStreaming = status === 'streaming' || status === 'submitted';
  const lastAssistantMessage = [...messages].reverse().find((m) => m.role === 'assistant');
  const lastAssistantText = lastAssistantMessage ? extractText(lastAssistantMessage) : '';
  const hasAgreedScope = /##\s*Agreed scope/i.test(lastAssistantText);

  function onSend() {
    const trimmed = input.trim();
    if (!trimmed || !repo) return;
    sendMessage({ text: trimmed });
    setInput('');
  }

  function onApprove() {
    if (!hasAgreedScope || !lastAssistantMessage) return;
    if (!title.trim()) {
      setApproveErr('Give the feature a short title before approving.');
      return;
    }
    setApproveErr(null);
    startApproveTransition(async () => {
      try {
        const fd = new FormData();
        fd.append('repo', repo);
        fd.append('title', title.trim());
        fd.append('pm_final_message', lastAssistantText);
        await approveAndStart(fd);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('NEXT_REDIRECT')) throw e;
        setApproveErr(msg);
      }
    });
  }

  if (repos.length === 0) {
    return (
      <p className="text-muted-foreground">
        No wired-up repos yet. Wire one up on{' '}
        <a className="underline" href="/repos">
          /repos
        </a>{' '}
        first.
      </p>
    );
  }

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="repo">Repo</Label>
        <Select name="repo" value={repo} onValueChange={setRepo}>
          <SelectTrigger id="repo">
            <SelectValue placeholder="Select a repo" />
          </SelectTrigger>
          <SelectContent>
            {repos.map((r) => (
              <SelectItem key={`${r.owner}/${r.name}`} value={`${r.owner}/${r.name}`}>
                {r.owner}/{r.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="rounded-md border border-border bg-card p-4">
        <div className="mb-3 flex flex-col gap-3">
          {messages.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Pitch an idea below. The PM will push back, surface conflicts with what&apos;s in
              flight, and help you scope it. When you&apos;re aligned, it&apos;ll write an
              &ldquo;Agreed scope&rdquo; block — that&apos;s your cue to approve and start.
            </p>
          ) : (
            messages.map((m) => (
              <div
                key={m.id}
                className={
                  m.role === 'user'
                    ? 'rounded bg-muted/50 p-3 text-sm'
                    : 'rounded border border-border p-3 text-sm'
                }
              >
                <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {m.role === 'user' ? 'You' : 'PM'}
                </div>
                <div className="whitespace-pre-wrap leading-relaxed">{extractText(m)}</div>
              </div>
            ))
          )}
          {isStreaming && messages[messages.length - 1]?.role === 'user' ? (
            <div className="rounded border border-border p-3 text-sm text-muted-foreground">
              PM is thinking…
            </div>
          ) : null}
          {error ? (
            <div className="rounded border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
              {error.message}
            </div>
          ) : null}
        </div>

        <div className="flex flex-col gap-2">
          <Textarea
            placeholder="Describe the feature in 1–3 sentences."
            rows={3}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                onSend();
              }
            }}
            disabled={isStreaming}
          />
          <div className="flex justify-end">
            <Button onClick={onSend} disabled={isStreaming || !input.trim()}>
              {isStreaming ? 'Sending…' : 'Send'}
            </Button>
          </div>
        </div>
      </div>

      <div
        className={
          hasAgreedScope
            ? 'rounded-md border border-emerald-500/50 bg-emerald-500/10 p-4'
            : 'rounded-md border border-dashed border-border p-4 opacity-60'
        }
      >
        <h3 className="mb-2 font-medium">Approve and start implementation</h3>
        <p className="mb-3 text-sm text-muted-foreground">
          {hasAgreedScope
            ? 'PM has written an "Agreed scope" — give the feature a short title and start the implementation.'
            : 'Once the PM agrees on a scope (you\'ll see an "Agreed scope" section in its response), this will activate.'}
        </p>
        <div className="flex flex-col gap-2">
          <Label htmlFor="title">Feature title</Label>
          <input
            id="title"
            type="text"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            placeholder="e.g., Instructor self-serve scheduling"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={!hasAgreedScope || approving}
          />
          <div className="flex justify-end">
            <Button onClick={onApprove} disabled={!hasAgreedScope || approving} variant="default">
              {approving ? 'Starting…' : 'Approve and start'}
            </Button>
          </div>
          {approveErr ? (
            <p className="text-xs text-destructive">{approveErr}</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * UIMessage in AI SDK v6 stores content as a `parts` array of typed
 * fragments (text, reasoning, tool calls, ...). Pull just the text.
 */
function extractText(m: UIMessage): string {
  return m.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('');
}
