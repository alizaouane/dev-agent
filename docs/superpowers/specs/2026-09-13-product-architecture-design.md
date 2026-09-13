# Product architecture: one UI for agent-driven development

**Status:** Draft (revision 5; independent spec review verdict: approved with nits, nits applied)
**Date:** 2026-09-13
**Scope:** umbrella architecture for milestone 1. Each build part in section 10 gets its own spec, plan and PRs; this document fixes the boundaries and the rules those specs must follow.

## 1. Problem

Development across the founder's apps runs through three surfaces that do not agree: Claude Code in a terminal for brainstorming and ad-hoc work, dev-agent's GitHub Actions phase workflows for batch work, and dev-agent's dashboard for approvals and status. Run history, cost and live output are scattered across Actions logs and issue comments. The engine is tied to one coding agent, and the dashboard is built for one user.

The goal is one product that is the only UI for the whole process, from brainstorming to production, and that:

- works with more than one coding agent (Claude Code and Codex first) and more than one model;
- serves other developers and companies later, so it is multi-tenant from the start;
- keeps the process dev-agent already enforces: spec and story approval, the ACM gate, swarm review, the session log.

## 2. Decisions already made

| Decision | Choice | Rejected |
|---|---|---|
| Audience | A product for others; the founder's own repos are customer one | Personal tool only |
| Milestone 1 | The founder's ~10 repos run through the product on the multi-tenant architecture, with Claude Code and Codex swappable | Outside customers in milestone 1 |
| Where agents run | Pluggable runner; first backend is the customer's own GitHub Actions; a hosted sandbox for live chat | Product-hosted compute for batch runs |
| Brainstorming | Live, inside the product, with a real coding agent and the repo's skills | A bespoke in-browser chat without the agent's skills (reversed in May 2026 for losing skill quality) |
| Build approach | New control plane; today's engine becomes the Actions backend; repos move one at a time | Retrofit tenancy into today's dashboard; build on an existing agent platform |
| Chat surface | Product-rendered chat from normalised agent events, with an "open terminal" escape hatch on the same sandbox and agent session | Terminal only; rendered chat only |
| Agent protocol | Our own adapters now, with events, requests and names taken from Agent Client Protocol (ACP); ACP adapters are the target | Depending on ACP from day one |

## 3. Current state this replaces

Verified against the code on 2026-09-13 (main at `8f049ce`).

- **Login and access.** The dashboard uses a GitHub OAuth user token with scopes `read:user user:email repo workflow read:org`, and access is limited by the `ALLOWED_GH_USERNAMES` / `ALLOWED_GH_ORGS` environment allowlists (`dashboard/lib/auth.ts`).
- **No database.** All state lives in GitHub: issues, labels, comments, files.
- **One shared agent key.** The dashboard seals its own `ANTHROPIC_API_KEY` with libsodium and pushes it into every wired repo as an Actions secret (`dashboard/lib/propagated-secrets.ts`, `dashboard/lib/gh-secrets.ts`).
- **Moving refs.** Consumer wrappers call reusable workflows at `alizaouane/dev-agent/...@main` (`dashboard/lib/wire-up-template.ts`); phase workflows check out the engine at `ref: main`, with one job pinned to a SHA (`phase-staging-deploy.yml` session-log job).
- **Wrappers are event-driven, not only dispatched.** They also trigger on `issues: labeled`, `issue_comment`, `pull_request` and `schedule`.
- **Claude-shaped engine.** Nine workflows call `anthropics/claude-code-action` (12 call sites); Claude model IDs are hard-coded in workflows, `lib/pricing.ts`, `lib/types.ts`, prompts and skills; skills and commands ship in Claude plugin format (`.claude-plugin/`); there is no `AGENTS.md`.
- **Approvals are human-local commits.** `approve-spec` and `approve-story` run in the human's own Claude Code session, the start-feature skill forbids running them on the user's behalf, and the stamp records the git identity of that session (`skills/start-feature/SKILL.md`, `dashboard/lib/story-approval.ts`).
- **Budget gate.** `lib/cli/budget-gate.ts` refuses a run when the month's budget is already spent, but it reads spend from issue comments after the fact and does not reserve under concurrency, so parallel runs can overshoot.
- **Stub mode** skips the agent step entirely and produces no agent stream (`phase-implement.yml`).
- **Agent key exposure in Actions.** The agent's Bash runs in the same job as `ANTHROPIC_API_KEY` and `id-token: write`.

## 4. Architecture

Three layers, each behind an interface the layer above depends on.

### 4.1 Control plane (new app)

- **Stack:** Next.js App Router on Vercel, Supabase Postgres, Supabase Auth with the GitHub provider, Supabase Realtime and Storage. Any deviation needs an ADR.
- **Owns:** organisations and members, projects, the GitHub App, runs and run events, credentials, budgets and cost, approvals of record, the product UI.
- **Does not own:** the content of specs, stories, plans and code. Those stay in git. The product displays them and triggers the engine.

### 4.2 Approvals in the product

Today an approval is a commit carrying the approving human's git identity. When a human approves in the product, the commit is made by the GitHub App bot, so git alone no longer says who approved. The design keeps approvals verifiable from git:

- The control plane records the approval (approver's GitHub user id and login, repository id, file path, blob SHA of the approved content, time) and writes the stamp commit through the App.
- The stamp carries commit trailers with those fields, a key id, and an Ed25519 signature over them. Each organisation has its own signing key, held only by the control plane, so a leaked key cannot forge approvals for another organisation.
- The control plane publishes each organisation's current and previous public keys by key id. `verify-approval` fetches the key named by the stamp; if the key cannot be fetched or is not listed, it refuses (unknown is not absent). Approval verification therefore depends on the control plane being reachable: an outage stops builds on moved projects rather than letting them through. Rotation keeps the previous key listed until every stamp signed with it has been superseded or re-signed.
- **Once a project is on the product, `verify-approval` accepts only product stamps** whose signature verifies and whose blob SHA matches the content being built. Today's local stamp is a file whose approver is free text and whose commit author is never checked, so anyone with write access could commit one naming anyone. Local stamps stay valid only for repositories not yet moved to the product, with that known limitation.
- Only a human action in the UI creates an approval. No agent, run or automation can call the approval endpoint.
- Part 1's spec defines the trailer format, key storage and rotation; part 2 updates `verify-approval` and the per-project switch.

### 4.3 Runner interface and backends

The control plane depends on one interface:

- `start(runSpec) -> runId`: create and launch a run.
- Events reach the control plane as numbered, append-only run events (section 5).
- `cancel(runId)`: stop a run, best effort, confirmed by a terminal status.

Backends:

- **GitHub Actions (batch runs).** The GitHub App calls `workflow_dispatch` on the consumer's wrapper with the product run id as an input. GitHub returns the created workflow run id; the control plane stores it before the run leaves `starting`, and fails the run closed if none is returned. Re-runs are tracked by `run_attempt`. The wrapper runs the engine at a version pinned per project (a tag or SHA, in both the wrapper `uses:` ref and the engine checkout), replacing today's `@main`.
- **Runs the product did not start.** Wrappers keep their event triggers during migration. A `workflow_run` webhook for a wrapper run with no product run id creates an adopted run (origin `github`), so every run appears in the product. Part 5 decides per repository whether those triggers stay.
- **Hosted sandbox (live chat).** One sandbox per chat session. The provider (E2B, Daytona or Modal) is chosen in part 4's spec behind the runner interface. Requirements: per-sandbox isolation, an egress allowlist, attachable PTY, and file persistence or snapshot for resume.

### 4.4 Agent adapter contract

One contract, used by both backends, replacing `claude-code-action` inside the engine.

- **Invocation:** the command, environment and working directory to run one agent turn for a task, agent and model, including resuming a prior agent session.
- **Output:** turn the agent's output into ACP-named session updates: `agent_message_chunk`, `tool_call`, `tool_call_update`, `plan`, `usage_update`. A turn ends with an ACP-style `stopReason`, not a "done" event.
- **Permissions are a two-way request, not an event.** Like ACP's `session/request_permission`, the adapter raises a request, the run parks in `waiting_for_you`, and the answer is sent back to the agent. For Claude Code in the sandbox, the bridge hosts the MCP tool named by `--permission-prompt-tool`. For batch runs, there is no human to ask: permissions come from a fixed allowlist, and anything outside it is denied. Today's implement allowlist includes unrestricted `Bash`, which makes it nominal; part 2 narrows the Bash patterns per phase, and until then the allowlist is not counted as a security control.
- **Adapters in milestone 1:**
  - Claude Code: `claude -p` with `--output-format stream-json`, `--resume` (which accepts a session `.jsonl` path) and `--permission-prompt-tool`.
  - Codex batch runs: `codex exec --json`, with `CODEX_API_KEY` rather than `OPENAI_API_KEY`.
  - Codex live chat: built on the Codex app server or the maintained `codex-acp` adapter, because `codex exec` has no documented external approval routing and its resume depends on local session files. Part 5's spec decides after a spike.
- **ACP target:** because names and the permission request already follow ACP, an ACP client adapter can replace a raw-stream adapter without changing the control plane or the UI.
- **Instructions and skills:** Claude Code reads `CLAUDE.md` and the repo's Claude skills; Codex reads `AGENTS.md`. Adding Codex includes generating or maintaining `AGENTS.md` for migrated repos.

## 5. Runs and events

### 5.1 Data

- **`runs`:** organisation, project, kind (`batch` | `chat`), origin (`product` | `github`), phase, backend (`actions` | `sandbox`), agent, model, status, failure reason, GitHub workflow run id and attempt, cost, timestamps.
- **Status:** `queued -> starting -> running <-> waiting_for_you -> succeeded | failed | cancelled`. Terminal statuses never change.
- **`run_events`:** run, sequence number, type, trust (`engine` | `agent` | `github` | `product`), payload, time. Append-only. The pair (run, sequence number) is unique; a repeated sequence number is ignored. Events arriving after a terminal status are stored but do not change the status.
- **Coalescing:** message chunks are merged per flush window (for example 250 ms) before they are stored, and each completed message is stored once as a whole. The run timeline is rebuilt from completed messages, not from every token.
- **Growth:** `run_events` is partitioned by month with a retention policy set per plan; part 1 sets the milestone 1 value.
- **Redaction:** every event payload is passed through secret redaction (known key formats plus the org's stored secrets) before it is stored or broadcast, not only error output.

### 5.2 Live output

The backend posts events; the control plane writes them; the database broadcasts each new event on a Supabase Realtime Broadcast channel per run, marked private on both the sending and the subscribing side (a private broadcast reaches only private channels), and authorised by row-level security on `realtime.messages`. `postgres_changes` is not used for run output: it checks authorisation per subscriber per change on a single thread, and its row-level security does not apply to deletes. A page reload replays the run from the table. Screens uploaded by the chat bridge are stored in Supabase Storage under a per-organisation path with Storage row-level security.

### 5.3 Batch run flow

1. A product action (for example, a human approving a story) creates a run in `queued`.
2. The GitHub App dispatches the wrapper with the product run id and stores the returned workflow run id.
3. The engine posts events authenticated with the job's GitHub Actions OIDC token. The control plane requires all of: a product-specific `aud`; `repository_id` equal to the project's repository id (not the name, which can change); `job_workflow_ref` equal to the pinned engine workflow for that project; and `run_id` equal to the stored workflow run id. For a run the product did not start, the first event with an otherwise valid token creates the adopted run bound to that `run_id`, so events that arrive before the `workflow_run` webhook are not rejected.
4. **Status never comes from events.** Events are display only, and a run's status comes from GitHub's workflow result.
5. **Gate verdicts come only from the gate job's own result.** Today ACM and swarm verdicts are labels and comments written with the token of the job the agent runs in, so re-reading them would trust data produced next to the agent. Check runs cannot fix this: every check run created in Actions is credited to the same app, and nothing in the API ties one to the job that created it. In the product design, each gate runs in its own job with no agent step, and that job's final verdict step fails exactly when the gate says no. The product reads the verdict from `GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs` for the stored workflow run id and attempt, matching the gate job by its name in the pinned engine workflow. The verdict step's conclusion decides pass or fail; a failure in any earlier step of that job counts as `infrastructure`, not a gate result. Verdict details travel as an artifact and are display only. Approvals are verified from signed stamps (section 4.2).

   Obligations for part 2's spec, since today's gates do not yet have this shape:
   - **Swarm review** runs its reviewer agents inside the gate job today. The reviewers move to their own jobs, and an agent-free job aggregates their artifacts into the verdict. The reviewers' findings remain agent-produced; what the design guarantees is that the aggregation and pass/fail rule are not.
   - **ACM** runs agent-written tests in the gate job, and that code can write `$GITHUB_ENV` or `$GITHUB_PATH` to change later steps. The verdict is therefore the test process's own exit code in the final step, with nothing after it; any remaining influence of agent-written code on its own verdict is listed in step 6 as accepted.
   - **Verdict step rules:** it must not use `continue-on-error` (the API reports only `conclusion`, which reads `success` for a failed step with that flag), and a `skipped` verdict step counts as not evaluated, never as a pass.
   - **Job name matching:** GitHub's documentation does not define how reusable-workflow job names are composed, and the jobs API does not expose `job_workflow_ref`. The product matches the exact caller job key from the wrapper it generates plus the gate job's name, gate job names may not use expressions, and a wrapper that differs from the generated one marks the project as needing repair. Someone with write access to the repository can still define a look-alike job in the wrapper; that is the trust boundary, the same as for any repository-write attacker.
   - **Re-runs:** part 2 confirms how a partial re-run's attempt lists jobs carried over from an earlier attempt, and reads the verdict from the attempt that actually ran the gate job.
6. **Accepted risks inside an agent job.** The agent's Bash shares the job with the OIDC request token and the agent credential. A prompt-injected agent can add misleading timeline entries, labelled with their trust level, and can under-report usage to delay a budget cancel. The controls that do not depend on the agent are the per-run wall-clock cap and the vendor console limit.
7. **Reducing that exposure is part 2's decision between two named options:** a credential proxy (the agent talks to a local proxy that holds the key; the key never enters the agent's environment, and the proxy's own usage counts become the trusted metering), or posting events from a sidecar process started before the agent, which removes the agent's need for `id-token` but not the key. Part 2 also adds an egress allowlist for agent steps.
8. GitHub App webhooks (`workflow_run`, `pull_request`, `issues`) are verified by HMAC, de-duplicated on `X-GitHub-Delivery`, and routed by installation id to exactly one organisation; a repository id belongs to exactly one project.

### 5.4 Chat run flow

1. Your message is stored as an event; the run moves to `running`.
2. The sandbox's bridge holds a websocket to the control plane, authenticated with a per-session token, and receives the message.
3. The bridge runs one agent turn through the adapter and streams normalised events back.
4. At the end of the turn the run returns to `waiting_for_you`. A permission request also parks the run in `waiting_for_you` until you answer.
5. **Visual screens:** the agent writes HTML screens to a watched folder; the bridge uploads them to Storage and the product shows them in a side panel. Clicks come back as your next message.
6. **Finish:** the bridge uploads the spec change as a patch; the control plane commits it to a branch and opens a PR through the App. **No GitHub write token ever enters the sandbox**, since the agent's Bash could read anything the bridge can.
7. **Terminal escape hatch:** "Open terminal" attaches an in-browser terminal to the sandbox's PTY and the same agent session. Terminal turns bypass the adapter, so they produce no live events or permission requests: the terminal has a wall-clock cap, its usage is priced afterwards from the agent's session file, and the chat shows a summary marked as reconstructed. Because there is no detected turn end in the terminal, the resume copy is taken when the terminal detaches or goes idle for a set time.
8. **Resume:** after every completed turn, the bridge saves two things, encrypted, to Storage: a copy of the agent's session files as of that turn (the main transcript and any subagent transcripts), and a snapshot of the workspace (uncommitted changes included). Agent credential files, such as a subscription sign-in stored under the agent's home directory, are excluded from both copies and from anything else the product stores. Reopening a chat restores both into a new sandbox at the same workspace path, since transcripts record the working directory, and resumes from that completed-turn copy. The copy never contains an interrupted turn, so a turn killed for budget or a crash is not continued on resume, which Claude Code would otherwise do after SIGTERM. Codex resume from a restored file is unverified and is a part 5 spike.

### 5.5 What runs in the sandbox, and what it can reach

- Claude Code runs in its normal mode, not `--bare`, because live chat needs `CLAUDE.md` and the repo's skills. That mode also runs the repo's `.claude/settings.json` hooks and `.mcp.json` servers from the branch being chatted on.
- **This is an accepted risk, not a mitigated one.** Anyone who can push a branch to the repository can plant a hook. The sandbox holds no GitHub write token and egress is restricted to an allowlist (the agent vendor's API, package registries, and hosts the organisation adds), but allowed hosts can still carry data out, and a hook could leak the agent credential, including a user's subscription sign-in. Organisations are told this when they enable live chat, and part 4 evaluates running chats only on branches whose hook and MCP files match the default branch.
- The only credentials in the sandbox are the agent credential (section 6.2) and a read-only GitHub installation token for that one repository, valid for at most one hour and refreshed by the control plane.

## 6. Tenancy, credentials and cost

### 6.1 Tenancy

- The organisation is the customer. Members have a role: owner, admin, member, viewer.
- Login proves identity only. Repo access comes only from the organisation's GitHub App installation. A project is one installed repository.
- Every table carries the organisation. Row-level security allows access only to that organisation's members, and covers Realtime channels and Storage objects.
- The server's elevated database key is used only for event ingest and webhooks, both after verifying the caller.
- Compute is never shared across organisations: batch runs use the customer's own GitHub account, and each chat has its own sandbox.

### 6.2 Credentials

| Credential | Rule |
|---|---|
| Batch runs | An API key per organisation (Anthropic for Claude Code, OpenAI for Codex), with a per-project override. Batch runs are unattended, so they need a stored credential, and the product must not store claude.ai credentials or session tokens. |
| Live chat | Either the organisation's API key, or the chatting user signing in inside the sandbox to the unmodified agent binary with their own subscription. The product must not collect, store or intermediate those subscription credentials, must not remove or restrict the binary's built-in sign-in methods, and must not pay for, resell or intermediate usage. A subscription sign-in lives only in that sandbox and is not restored on resume. |
| Terms | Anthropic's Commercial Terms apply to the product. OpenAI's equivalent position is unverified. A legal review of both vendors' terms is a gate before part 3 and part 4 ship, since part 4 carries subscription sign-in and drives the binary headless. |
| Storage | API keys are stored once, encrypted with a per-organisation data key, which is itself encrypted by a master key in a managed KMS. Part 3 chooses between Supabase Vault and a cloud KMS, and defines data key rotation. Write-only in the UI: after saving, only the last 4 characters are shown. |
| Use | Decrypted only to start a sandbox (as an environment variable) and to sync into the repository's Actions secrets through the GitHub App. |
| GitHub | Installation tokens minted per use, restricted with `repositories` and `permissions` to one repository and the permissions needed, lasting at most one hour. Write tokens are only ever used by the control plane or inside the customer's own Actions job, never inside a sandbox. |
| Callbacks | Actions jobs authenticate with their OIDC token (section 5.3); sandboxes with a per-session token. |

### 6.3 Cost limits

- **Levels:** organisation per month, project per month, per run, per chat session. Alerts at 50%, 80% and 100%.
- **Money** is stored as integer micro-units of the currency. Prices come from a price table with an effective-from date per model, so past runs keep the price that applied.
- **Reserve before start:** before any run or chat turn starts, the control plane reserves that run's cap in one transaction that locks the budget rows (`SELECT ... FOR UPDATE`), and refuses if the reservation does not fit. Unused reservation is released when the run ends.
- **Cancel while running:** usage updates are priced as they arrive. Crossing a cap cancels the run: the sandbox turn is killed, or the Actions run is cancelled through the GitHub API.
- **Backstop:** metering is an estimate and cancellation takes seconds. Onboarding asks the customer to set a spend limit in their Anthropic and OpenAI consoles and to confirm it with a checkbox. The product cannot read those limits: Anthropic's Spend Limits API is Enterprise-only, and reading usage needs an Admin key the product will not collect.
- **Subscription chats** are metered from usage updates for display, but the spend is the user's subscription, not the organisation's API budget.
- **Sandbox minutes** are metered and capped per organisation, since the product pays for them.

## 7. Failure handling

### 7.1 Rules

1. **Every run ends with a reason.** Failure reasons: `gate`, `agent_error`, `infrastructure`, `budget`, `timeout`, `disconnected`; or `cancelled` with who and when. A gate saying no is a result, shown differently from an error.
2. **Unknown is not absent.** If the product cannot read the budget, verify an approval, mint a token or learn the workflow run id, the run does not start. It never falls back to a broader credential or a default.
3. **No silent retries of side effects.** A turn that may have written files, pushed or commented is never re-run automatically, including on resume. Read-only turns may retry once.

### 7.2 Cases

| Failure | Handling | Visible to the user |
|---|---|---|
| Control plane unreachable during a batch run | The engine buffers events to a file uploaded as a workflow artifact. On recovery, the workflow notification or the reconciler closes the run from GitHub's result and backfills events from the artifact. Unreachable at start: the run refuses because the budget reservation cannot be made. | Run fills in, marked "events recovered" |
| Dispatch returns no workflow run id | The run fails closed as `infrastructure`; nothing is left running untracked | Reason with a retry button |
| Events lost, duplicated or out of order | Sequence numbers: duplicates ignored, order restored, gaps kept | "N events missing" |
| Event with an invalid OIDC token or claim mismatch | Rejected and logged as a security event for the organisation. A valid token for a workflow run the product has not seen creates an adopted run instead. | Admin security log entry |
| Gate job missing from the stored workflow run, renamed, or ended before its verdict step | No verdict is taken; the run fails as `infrastructure` | Gate shown as not evaluated, with the job link |
| A second run of the pinned engine workflow in the same repository with a valid token | Adopted as its own run: the token proves engine code in that repository, not that a wrapper started it. Accepted, since only engine code can produce it. | Run marked "started from GitHub" |
| Webhook lost or duplicated | Duplicates dropped by delivery id. A reconciler checks unfinished runs against the GitHub API every few minutes; a run stuck in `starting` past its timeout fails as never started. | Reason plus a link to the Actions run |
| Wrapper run started outside the product | Adopted from the `workflow_run` webhook as origin `github` | Run appears, marked "started from GitHub" |
| Sandbox crash or provider outage | Bridge heartbeat; 60 seconds without one fails the turn as `infrastructure`. Resume restores the last completed turn and its workspace snapshot. | Partial turn labelled interrupted; "Reopen chat" |
| Agent hangs or errors | Wall-clock timeout per turn and per run; the error event keeps the redacted output tail | Error card with retry |
| Agent key rejected | Fail immediately, no retries; key flagged invalid; new runs refuse until replaced | Banner for admins |
| Vendor overloaded or rate limited | Agent CLI retries first; then `agent_error` | Error card with retry |
| GitHub App removed, repo renamed or transferred, permission missing | Renames are harmless (bound by repository id); removal or a missing permission marks the project disconnected, and runs refuse naming what is missing | "Reconnect" |
| Cap crossed but cancel fails | Retry cancel, alert admins; the vendor console limit is the backstop | "Cancel pending" |
| Spec push rejected because the branch moved | The control plane replays the docs-only patch on the new head; a real conflict becomes a question in the chat | A chat question |
| Approval stamp signature invalid, key not fetchable, or a local stamp on a project moved to the product | `verify-approval` refuses; the build does not start | Gate result naming the stamp and why |
| User cancels | Always ends `cancelled`; late events stored but do not change status | Cancelled, who and when |

## 8. Security summary

- Approvals are verifiable from git through signed product stamps (section 4.2).
- Status never comes from events a run posts, and gate verdicts come only from the conclusion of agent-free gate jobs in the stored workflow run, read from the Actions jobs API (section 5.3).
- Projects on the product accept only signed, per-organisation approval stamps (section 4.2).
- OIDC ingest checks audience, repository id, run id and reusable workflow ref.
- No GitHub write token in any sandbox; sandbox egress is allowlisted.
- Secrets are redacted from every stored or broadcast payload and from session snapshots, and snapshots are encrypted.
- Webhooks are verified, de-duplicated and routed to exactly one organisation.
- Repository hooks and MCP servers run only inside the customer's own isolated sandbox or Actions job; in live chat this remains an accepted risk (section 5.5).
- Known exposure inside agent jobs is listed in section 5.3, with part 2 choosing between a credential proxy and a sidecar poster.

## 9. Testing

- **Adapter contract tests:** recorded output streams from pinned Claude Code and Codex versions, replayed through each adapter, must produce the expected ACP-named events, stop reasons and permission requests. Upgrading a CLI re-records the fixtures, and the diff is reviewed. The same suite runs against ACP adapters later.
- **Stub adapter:** replays recorded streams so every phase runs end to end in CI with no model spend. This is new work: today's stub mode skips the agent step and emits nothing.
- **Isolation tests on a real test database** (no mocked database): for every table, Realtime channel and Storage path, a member of one organisation cannot read or write another organisation's data.
- **Ingest security tests:** wrong audience, wrong repository id, wrong run id, wrong workflow ref, replayed sequence number, expired session token, forged webhook signature, duplicate delivery; all refused or ignored.
- **Approval tests:** an App-authored stamp without a valid signature, a signature over a different blob SHA, an unknown or unfetchable key id, another organisation's key, and a local stamp on a moved project are all refused; a valid product stamp passes.
- **Gate provenance tests:** a verdict is taken only from the named gate job of the stored workflow run and attempt; a same-named job in another run, a label or comment claiming a verdict, and a gate job that failed before its verdict step all produce no gate pass.
- **Failure tests:** every row of section 7.2 checks the final status and reason.
- **Budget race test:** two runs reserving the last of a budget concurrently; exactly one starts.
- **Resume test:** kill a turn mid-way, reopen the chat, and confirm the killed turn is not continued, the workspace and subagent transcripts match the last completed turn, and no credential file was stored.
- **End to end:** Playwright drives the product against a dedicated test GitHub organisation using the stub adapter.
- **Nightly live smoke:** one short real run per agent on a throwaway repository, under a small cap.

## 10. Delivery

### 10.1 Build parts

Each part has its own spec, plan and PRs, and ships usable on its own.

1. **Control plane foundation:** organisations, login, GitHub App (webhook verification and routing), projects bound by repository id, isolation, runs and events with coalescing and Broadcast, the live run page, adopted runs from `workflow_run`, signed per-organisation approvals of record and published keys.
2. **Agent adapter in the engine:** replace `claude-code-action` with the adapter, Claude Code first; OIDC-authenticated events; engine pinned per project; `verify-approval` accepts only signed product stamps on moved projects; gate jobs separated from agent jobs, with verdicts read from job conclusions; credential proxy or sidecar poster; narrowed Bash allowlists; stub adapter.
3. **Credentials and cost:** per-organisation keys and KMS, secret sync, reserve-then-cancel, price table, console limit confirmation; the legal review of vendor terms gates it.
4. **Live chat:** sandbox provider choice, bridge, egress allowlist, Claude Code permission tool, rendered chat, visual screens, patch-based spec PRs, resume with workspace snapshots, terminal escape hatch, subscription sign-in in the sandbox; the legal review gates it.
5. **Codex and migration:** Codex batch adapter, Codex live chat on the app server or `codex-acp` after a spike, `AGENTS.md`, moving the repositories, retiring the old dashboard.

### 10.2 Moving the repositories

1. **Mirror only:** dev-agent is project one; the product adopts today's runs from webhooks. No behaviour changes.
2. **One low-risk app repository** gets a pinned engine version and a wrapper the product dispatches; its event triggers stay and are adopted.
3. **The rest, one at a time,** each with the checklist: install the App, set keys, confirm the vendor spend limit, pin the engine version, swap the wrapper, pass a stub run, pass one real run, confirm events and cost match.
4. **Codex on one repository,** compared with Claude Code on the same kind of story.
5. **Retire the old dashboard** after the last repository has moved.

Rollback for any repository is reverting its wrapper change; the engine underneath is unchanged.

### 10.3 Milestone 1 is done when

- All of the founder's repositories start their runs from the product, and the old dashboard is retired.
- A chat with Claude Code and a chat with Codex have each produced an approved spec that went through the batch pipeline to a merged PR.
- Every run in the product, product-started or adopted, ends with a status and reason, with events and cost visible.
- The isolation, ingest security, approval, failure, budget race and resume tests pass in CI.

## 11. Out of scope for milestone 1

- Outside customers, billing and plans.
- Hosted compute for batch runs.
- Agents other than Claude Code and Codex.
- Replacing git as the store for specs, stories, plans and code.

## 12. Verified during review, and still open

**Verified against live documentation on 2026-09-13:**

- Claude Code: `-p` with `--output-format stream-json`; `--resume` accepts a session `.jsonl` path; `--permission-prompt-tool`; a session resumed after SIGTERM continues the unfinished turn; non-`--bare` `-p` runs project hooks and MCP servers.
- Codex: `codex exec --json` and `codex exec resume <SESSION_ID>`; `CODEX_API_KEY` recommended over `OPENAI_API_KEY` in CI.
- ACP: `session/request_permission` is a request; `usage_update` is a session update; a turn ends with a `stopReason`; `codex-acp` is described as built on the Codex app server (seen in search results, not yet confirmed from its repository).
- GitHub: OIDC tokens carry `aud`, `repository_id`, `run_id`, `run_attempt`, `job_workflow_ref`; installation tokens last one hour and accept `repositories` and `permissions`; `workflow_dispatch` returns the workflow run id and accepts up to 25 inputs.
- Supabase Realtime: `postgres_changes` authorises per subscriber per change on a single thread and does not apply row-level security to deletes; Broadcast with `realtime.messages` policies is the scalable path.
- Anthropic: the terms quoted in section 6.2; the Spend Limits API is Enterprise-only.
- E2B: a client can reconnect to a running PTY.

**Still open, owned by a part spec:**

1. Codex live chat base (app server or `codex-acp`) and Codex resume from a restored session (part 5).
2. Daytona and Modal PTY attach, snapshots and egress controls (part 4).
3. OpenAI's terms for products serving others, and the legal review of both vendors (gate before parts 3 and 4).
4. KMS choice and data key rotation (part 3).
5. Approval stamp trailer format, signing key storage and rotation (part 1).
6. Which wrapper event triggers each repository keeps (part 5).
7. Credential proxy or sidecar event poster for agent jobs, and per-phase Bash allowlists (part 2).
8. Restricting live chat to branches whose hook and MCP files match the default branch (part 4).
