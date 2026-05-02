import type { NotificationsConfig, ArtifactsConfig } from './types.js';

export type GateKind =
  | 'spec-ready'
  | 'pr-review'
  | 'staging-deployed'
  | 'ready-to-promote'
  | 'done'
  | 'blocked'
  | 'rolled-back';

export interface NotifyPayload {
  gate: GateKind;
  title: string;
  body: string;
}

export interface NotifyDeps {
  fetch: typeof fetch;
  appendStatusLine: (path: string, line: string) => Promise<void>;
  commentOnIssue: (repo: string, issue: number, body: string) => Promise<void>;
}

export interface NotifyContext {
  config: NotificationsConfig;
  artifactsConfig: Pick<ArtifactsConfig, 'status_file'>;
  secrets: Record<string, string>;
  issueNumber: number;
  repo: string;
  deps: NotifyDeps;
}

export interface NotifyResult {
  successes: string[];
  failures: { channel: string; error: string }[];
}

export async function notify(ctx: NotifyContext, payload: NotifyPayload): Promise<NotifyResult> {
  const successes: string[] = [];
  const failures: { channel: string; error: string }[] = [];

  // Push (ntfy.sh / pushover / slack-webhook)
  if (ctx.config.push) {
    try {
      const url =
        ctx.config.push.provider === 'ntfy.sh'
          ? `https://ntfy.sh/${ctx.config.push.topic}`
          : ctx.config.push.topic; // pushover/slack-webhook expect full URL in `topic`
      const res = await ctx.deps.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain', Title: payload.title },
        body: payload.body,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      successes.push('push');
    } catch (err) {
      failures.push({ channel: 'push', error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Email (Resend)
  if (ctx.config.email) {
    try {
      const apiKey = ctx.secrets[ctx.config.email.secret_name];
      if (!apiKey) throw new Error(`secret ${ctx.config.email.secret_name} not set`);
      const res = await ctx.deps.fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'dev-agent <noreply@' + (process.env.DEV_AGENT_EMAIL_DOMAIN ?? 'dev-agent.local') + '>',
          to: [ctx.config.email.to],
          subject: payload.title,
          text: payload.body,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      successes.push('email');
    } catch (err) {
      failures.push({ channel: 'email', error: err instanceof Error ? err.message : String(err) });
    }
  }

  // GitHub issue comment
  if (ctx.config.github_issue) {
    try {
      await ctx.deps.commentOnIssue(ctx.repo, ctx.issueNumber, `**[${payload.gate}]** ${payload.title}\n\n${payload.body}`);
      successes.push('github_issue');
    } catch (err) {
      failures.push({ channel: 'github_issue', error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Status file append
  if (ctx.config.status_file) {
    try {
      const line = `[${new Date().toISOString()}] #${ctx.issueNumber} ${payload.gate}: ${payload.title}\n`;
      await ctx.deps.appendStatusLine(ctx.artifactsConfig.status_file, line);
      successes.push('status_file');
    } catch (err) {
      failures.push({ channel: 'status_file', error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { successes, failures };
}
