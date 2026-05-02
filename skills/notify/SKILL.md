---
name: notify
description: Use to fan out gate-transition notifications across push (ntfy/pushover/slack), email (resend), GitHub issue comment, and the project status file. Wraps lib/notify.ts.
user-invocable: false
---

# notify

Wraps `lib/notify.ts` so phase workflows have a one-call notification primitive.

## Inputs

```ts
type NotifyPayload = {
  issueNumber: number;
  gate: 'spec-ready' | 'pr-review' | 'ready-to-promote' | 'done' | 'blocked' | 'rolled-back';
  title: string;
  summary: string;       // 1–3 lines, plain markdown
  cost?: number;         // dollars; included in body if present
  artifacts?: { label: string; url: string }[];
};
```

## Channels (configured via `notifications:` in `.dev-agent.yml`)

| Channel | When | How |
|---|---|---|
| GitHub issue comment | always | `gh issue comment <n> --body` |
| Status file | always | append/upsert section in `<artifacts.status_file>` |
| Push | if `notifications.push` configured | HTTP POST to ntfy.sh / pushover / slack-webhook |
| Email | if `notifications.email` configured | Resend API; secret name from `notifications.email.secret_name` |

## Behavior

1. Always emits the issue comment + status-file update synchronously; failures here propagate (these are the "always-on" channels).
2. Push + email are best-effort; failures log a warning to stderr but don't fail the workflow.
3. All payloads honor `models.notification` (default `claude-haiku-4-5`) only when generating the summary text — when the caller already has summary text, no model call.

## Failure modes

- Missing `gh` CLI auth → fail loud (issue comment is the canonical channel).
- Resend API key secret missing while email is configured → log a warning, skip email, continue.

## Implementation status

`lib/notify.ts` is shipped in Plan 1a with full unit tests (3 test cases, HTTP mocks). This SKILL.md documents the contract that workflows in Plan 1c will consume.
