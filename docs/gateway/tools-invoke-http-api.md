---
summary: "Invoke a single tool directly via the Gateway HTTP endpoint"
read_when:
  - Calling tools without running a full agent turn
  - Building automations that need tool policy enforcement
title: "Tools Invoke API"
---

# Tools Invoke (HTTP)

OpenClaw’s Gateway exposes a simple HTTP endpoint for invoking a single tool directly. It is always enabled, but gated by Gateway auth and tool policy.

- `POST /tools/invoke`
- Same port as the Gateway (WS + HTTP multiplex): `http://<gateway-host>:<port>/tools/invoke`

Default max payload size is 2 MB.

## Authentication

Uses the Gateway auth configuration. Send a bearer token:

- `Authorization: Bearer <token>`

Notes:

- When `gateway.auth.mode="token"`, use `gateway.auth.token` (or `OPENCLAW_GATEWAY_TOKEN`).
- When `gateway.auth.mode="password"`, use `gateway.auth.password` (or `OPENCLAW_GATEWAY_PASSWORD`).
- If `gateway.auth.rateLimit` is configured and too many auth failures occur, the endpoint returns `429` with `Retry-After`.

## Request body

```json
{
  "tool": "sessions_list",
  "action": "json",
  "args": {},
  "sessionKey": "main",
  "dryRun": false
}
```

Fields:

- `tool` (string, required): tool name to invoke.
- `action` (string, optional): mapped into args if the tool schema supports `action` and the args payload omitted it.
- `args` (object, optional): tool-specific arguments.
- `sessionKey` (string, optional): target session key. If omitted or `"main"`, the Gateway uses the configured main session key (honors `session.mainKey` and default agent, or `global` in global scope).
- `dryRun` (boolean, optional): reserved for future use; currently ignored.

## Policy + routing behavior

Tool availability is filtered through the same policy chain used by Gateway agents:

- `tools.profile` / `tools.byProvider.profile`
- `tools.allow` / `tools.byProvider.allow`
- `agents.<id>.tools.allow` / `agents.<id>.tools.byProvider.allow`
- group policies (if the session key maps to a group or channel)
- subagent policy (when invoking with a subagent session key)

If a tool is not allowed by policy, the endpoint returns **404**.

Gateway HTTP also applies a hard deny list by default (even if session policy allows the tool):

- `sessions_spawn`
- `sessions_send`
- `gateway`
- `whatsapp_login`

You can customize this deny list via `gateway.tools`:

```json5
{
  gateway: {
    tools: {
      // Additional tools to block over HTTP /tools/invoke
      deny: ["browser"],
      // Remove tools from the default deny list
      allow: ["gateway"],
    },
  },
}
```

To help group policies resolve context, you can optionally set:

- `x-openclaw-message-channel: <channel>` (example: `slack`, `telegram`)
- `x-openclaw-account-id: <accountId>` (when multiple accounts exist)

## Responses

- `200` → `{ ok: true, result }`
- `400` → `{ ok: false, error: { type, message } }` (invalid request or tool input error)
- `401` → unauthorized
- `429` → auth rate-limited (`Retry-After` set)
- `404` → tool not available (not found or not allowlisted)
- `405` → method not allowed
- `500` → `{ ok: false, error: { type, message } }` (unexpected tool execution error; sanitized message)

## Example

```bash
curl -sS http://127.0.0.1:18789/tools/invoke \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{
    "tool": "sessions_list",
    "action": "json",
    "args": {}
  }'
```

## Optional Research Relay Endpoint

For a strict VPS relay model, the Gateway can expose a narrow research submission surface that forwards to a private/local worker service.

- `POST /research/submit`
- `GET /research/status/:job_id`
- `GET /research/health`

This relay is disabled by default and does not run research itself.

Environment variables:

- `RESEARCH_RELAY_ENABLED=false`
- `RESEARCH_UPSTREAM_URL=`
- `RESEARCH_SHARED_TOKEN=`
- `RESEARCH_REQUEST_TIMEOUT_SEC=15`
- `RESEARCH_MAX_TOPIC_LEN=500`
- `RESEARCH_MAX_LABEL_LEN=100`

Safety notes:

- Keep `RESEARCH_UPSTREAM_URL` on loopback/private IPs or Tailscale (`*.ts.net`).
- Keep heavy work on your local worker: search, scraping, extraction, embeddings, vector storage, and final report generation.
- When `RESEARCH_SHARED_TOKEN` is set, callers must provide it in `x-openclaw-research-token` in addition to normal Gateway bearer auth.

Example:

```bash
curl -sS http://127.0.0.1:18789/research/submit \
  -H 'Authorization: Bearer YOUR_GATEWAY_TOKEN' \
  -H 'x-openclaw-research-token: YOUR_RELAY_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{
    "topic": "portable dog water bottle market",
    "label": "market-scan"
  }'
```
