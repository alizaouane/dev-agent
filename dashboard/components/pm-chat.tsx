'use client';

import { useEffect, useState, useTransition } from 'react';
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
import { applyPmMdUpdate, approveAndStart } from '@/lib/actions';
import { clearDraft, loadDraft, saveDraft } from '@/lib/pm-chat-draft';
import { extractPmMdUpdate } from '@/lib/pm-md-update';

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
 * Persistence (Phase 3.2.5): the chat survives page reloads via
 * localStorage. Messages, the selected repo, the title input, and the
 * input draft are persisted; on approve-and-start, the draft is
 * cleared. The localStorage helpers live in lib/pm-chat-draft.ts so
 * they can be unit-tested in isolation.
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
  // First-paint state: we can't read localStorage during server render
  // (no `window`), and Next.js will hydration-warn if SSR HTML differs
  // from the first client render. So we defer the draft hydration to a
  // post-mount effect, and start with the URL/server-provided defaults.
  const initialRepoMatch =
    initialRepo && repos.some((r) => `${r.owner}/${r.name}` === initialRepo)
      ? initialRepo
      : null;
  const defaultRepo = initialRepoMatch ?? (repos[0] ? `${repos[0].owner}/${repos[0].name}` : '');

  const [repo, setRepo] = useState(defaultRepo);
  const [input, setInput] = useState(initialInput);
  const [title, setTitle] = useState('');
  const [approveErr, setApproveErr] = useState<string | null>(null);
  const [approving, startApproveTransition] = useTransition();
  // Hydrated state stays null until the first client effect runs; the
  // second pass replaces server defaults with persisted values without
  // a hydration mismatch.
  const [hydratedFromDraft, setHydratedFromDraft] = useState(false);
  const [persistedMessages, setPersistedMessages] = useState<UIMessage[] | undefined>(undefined);

  useEffect(() => {
    // Only hydrate when there are no URL-provided overrides; if the user
    // arrived via /proposals?prefill=..., they want a fresh chat seeded
    // with that pitch, not whatever stale draft they left behind.
    if (initialInput || initialRepo) {
      setHydratedFromDraft(true);
      return;
    }
    const draft = loadDraft();
    if (draft) {
      if (draft.repo && repos.some((r) => `${r.owner}/${r.name}` === draft.repo)) {
        setRepo(draft.repo);
      }
      setTitle(draft.title);
      setInput(draft.input);
      if (draft.messages.length > 0) {
        setPersistedMessages(draft.messages);
      }
    }
    setHydratedFromDraft(true);
    // Intentional: only run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const transport = new DefaultChatTransport({
    api: '/api/pm-chat',
    // Forward the selected repo with every turn so the server can refresh
    // the PM's context (pm.md + pipeline) for that specific repo.
    body: () => ({ repo }),
  });

  const { messages, sendMessage, status, error, setMessages } = useChat({
    transport,
    messages: persistedMessages,
  });

  // After the post-mount hydration runs, push the persisted messages
  // into the AI SDK's chat instance. The `messages` option in useChat
  // is only honored on first render of the underlying Chat — for
  // changes after that, we use setMessages explicitly.
  useEffect(() => {
    if (hydratedFromDraft && persistedMessages && messages.length === 0) {
      setMessages(persistedMessages);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydratedFromDraft, persistedMessages]);

  // Save draft whenever any meaningful field changes, but not before
  // hydration completes (would otherwise overwrite the just-loaded
  // draft with the empty defaults).
  useEffect(() => {
    if (!hydratedFromDraft) return;
    if (messages.length === 0 && !input && !title && repo === defaultRepo) {
      // Nothing worth persisting; clear any existing draft to avoid
      // surfacing it on the next visit.
      clearDraft();
      return;
    }
    saveDraft({ repo, title, input, messages });
  }, [hydratedFromDraft, messages, repo, title, input, defaultRepo]);

  const isStreaming = status === 'streaming' || status === 'submitted';
  const lastAssistantMessage = [...messages].reverse().find((m) => m.role === 'assistant');
  const lastAssistantText = lastAssistantMessage ? extractText(lastAssistantMessage) : '';
  // Mirror lib/actions.ts extractAgreedScope's heading regex so the
  // button activates exactly when the server-side parser will find a
  // scope. Minor heading variations (extra hashes, trailing colon,
  // capitalization) shouldn't strand the user with a disabled button.
  const hasAgreedScope = /^#{2,}\s*Agreed\s+Scope\s*[:\-—]?\s*$/im.test(lastAssistantText);
  const proposedPmMd = lastAssistantText ? extractPmMdUpdate(lastAssistantText) : null;
  const [pmUpdateErr, setPmUpdateErr] = useState<string | null>(null);
  const [applyingPmUpdate, startPmUpdateTransition] = useTransition();

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
        // Clear the draft optimistically — approveAndStart redirects on
        // success and we don't want the redirected feature page to keep
        // surfacing the same draft on the next /intent visit.
        clearDraft();
        await approveAndStart(fd);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('NEXT_REDIRECT')) throw e;
        // approveAndStart threw a real error before redirect; restore
        // the draft so the user can retry without retyping.
        saveDraft({ repo, title, input, messages });
        setApproveErr(msg);
      }
    });
  }

  function onApplyPmUpdate() {
    if (!proposedPmMd) return;
    setPmUpdateErr(null);
    startPmUpdateTransition(async () => {
      try {
        const fd = new FormData();
        fd.append('repo', repo);
        fd.append('new_content', proposedPmMd);
        // Use the current title as a hint for the commit/PR title; falls
        // back to a generic message in the server action if blank.
        if (title.trim()) fd.append('summary', `chore(pm.md): ${title.trim()}`);
        await applyPmMdUpdate(fd);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('NEXT_REDIRECT')) throw e;
        setPmUpdateErr(msg);
      }
    });
  }

  function onClearConversation() {
    if (messages.length === 0 && !input && !title) return;
    if (
      !window.confirm(
        'Clear the current conversation and start a new one? Persisted draft will be deleted.',
      )
    ) {
      return;
    }
    setMessages([]);
    setInput('');
    setTitle('');
    setApproveErr(null);
    clearDraft();
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
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button
              type="button"
              onClick={onClearConversation}
              disabled={isStreaming || (messages.length === 0 && !input && !title)}
              variant="ghost"
              size="sm"
            >
              Clear conversation
            </Button>
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

      {proposedPmMd ? (
        <div className="rounded-md border border-blue-500/50 bg-blue-500/10 p-4">
          <h3 className="mb-2 font-medium">PM proposes a pm.md update</h3>
          <p className="mb-3 text-sm text-muted-foreground">
            The PM noticed a pattern worth recording. Apply opens a PR replacing
            <code className="mx-1">.dev-agent/pm.md</code>
            with its proposed content — review the diff in the PR before merging.
          </p>
          <details className="mb-3 rounded border border-border bg-background p-3 text-xs">
            <summary className="cursor-pointer text-sm font-medium">Preview proposed pm.md</summary>
            <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs leading-relaxed">
              {proposedPmMd}
            </pre>
          </details>
          <div className="flex justify-end">
            <Button onClick={onApplyPmUpdate} disabled={applyingPmUpdate} variant="default">
              {applyingPmUpdate ? 'Opening PR…' : 'Apply (opens PR)'}
            </Button>
          </div>
          {pmUpdateErr ? <p className="mt-2 text-xs text-destructive">{pmUpdateErr}</p> : null}
        </div>
      ) : null}
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
