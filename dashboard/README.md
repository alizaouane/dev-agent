# dev-agent dashboard

Next.js app that surfaces dev-agent's pipeline, proposals, and cost telemetry.

## Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `ANTHROPIC_ADMIN_KEY` | Optional | Admin API key (`sk-ant-admin01-…`) used by the `/cost` page to fetch real Anthropic spend from the Admin Cost Report API. Create it in the Anthropic Console under Settings → Admin keys (requires org admin/owner). Server-only secret — never expose it to the client or log it. Set it in this dashboard's environment (e.g. Vercel → Settings → Environment Variables). Without it, `/cost` renders an explicit "not configured" notice instead of a spend total. |
