import { auth } from '@/lib/auth';
import { getOctokit } from '@/lib/gh';
import { fetchPipeline } from '@/lib/pipeline';
import { listAllowedRepos, wiredRepos } from '@/lib/repos';
import {
  buildPmPromptVars,
  readPmNotesFromRepo,
  renderPmSystemPrompt,
} from '@/lib/pm-prompt';
import { anthropic } from '@ai-sdk/anthropic';
import { convertToModelMessages, streamText, type UIMessage } from 'ai';

/**
 * Streaming chat with the PM agent. The browser POSTs `{ messages, repo }`
 * and receives a streamed text response (Server-Sent Events) compatible
 * with the Vercel AI SDK's useChat hook.
 *
 * Each invocation is stateless from the server's perspective: we re-fetch
 * `pm.md` and the pipeline on every turn so the PM always has the current
 * picture. Conversation history is held entirely in the client and forwarded
 * back on every request.
 *
 * Auth: gated by NextAuth — unauthenticated requests get 401 immediately.
 * Repo scope: the requested repo must be in the user's wired-up set
 * (otherwise we'd leak any repo's pm.md to anyone who can guess the slug).
 */
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.username) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }

  let body: { messages?: UIMessage[]; repo?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid JSON body' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  const messages = body.messages;
  const repoFull = body.repo;
  if (!Array.isArray(messages) || messages.length === 0 || typeof repoFull !== 'string') {
    return new Response(JSON.stringify({ error: 'messages[] and repo required' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  const [owner, repoName] = repoFull.split('/');
  if (!owner || !repoName) {
    return new Response(JSON.stringify({ error: 'repo must be owner/name' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  const octokit = await getOctokit();
  const repos = wiredRepos(await listAllowedRepos(octokit));
  const repo = repos.find((r) => r.owner === owner && r.name === repoName);
  if (!repo) {
    // Either the repo isn't wired up, or the user can't see it. Same
    // 403 either way — don't disclose which.
    return new Response(JSON.stringify({ error: 'repo not accessible' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
  }

  // Build the PM context. These two calls are the bulk of latency on a
  // turn (each is one or two GitHub round-trips); could be cached in a
  // future iteration if it becomes a bottleneck.
  const [pmNotes, pipeline] = await Promise.all([
    readPmNotesFromRepo(octokit, owner, repoName),
    fetchPipeline(octokit, [repo]),
  ]);

  const promptVars = buildPmPromptVars({
    consumer_root: '.',
    pmNotes,
    pipeline,
    request: 'evaluate_idea',
  });
  const systemPrompt = renderPmSystemPrompt(promptVars);

  const modelMessages = await convertToModelMessages(messages);

  const result = streamText({
    model: anthropic('claude-opus-4-7'),
    system: systemPrompt,
    messages: modelMessages,
  });

  return result.toUIMessageStreamResponse();
}
