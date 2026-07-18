# GitHub webhook transport and live receipt

Date: 2026-07-18

Ticket: #174

## Production route

The Planner GitHub App sends JSON webhooks to:

```text
https://ambient-agent.co-worker.tech/channels/github/webhook
```

`ambient-agent.co-worker.tech` is an explicit proxied Cloudflare DNS record. It
does not reuse the `co-worker.tech`, `app`, `api`, or `docs` Railway records. The
Cloudflare origin is the `code-factory` rig, where Caddy terminates TLS and
proxies only this hostname to Ambient Agent on `127.0.0.1:42069`:

```caddyfile
ambient-agent.co-worker.tech {
	reverse_proxy 127.0.0.1:42069
}
```

The application route is owned by `@flue/github`. It reads the exact request
bytes, verifies `X-Hub-Signature-256` with the managed Planner App webhook
secret, and only then parses or admits the payload. An unsigned public probe
returns HTTP 401.

## GitHub App configuration

The App is `Ambient Planner` (`ambient-planner`). Its repository permissions
remain the existing minimum: Issues read/write, Pull requests read-only, and
Metadata read-only. Its webhook is active with SSL verification enabled and is
subscribed to exactly:

- Issues
- Pull request
- Pull request review

The active webhook signing secret is stored only in the rig's managed
`github-planner.json` credential and the GitHub App hook. During setup, a local
capture was rejected because GitHub renders the secret field in clear text; the
credential was immediately rotated and that capture is not PR evidence. No
secret value appears in this repository, GitHub evidence, or the redacted
operational receipts below. URL/secret rotation uses an App JWT with GitHub's
`PATCH /app/hook/config` endpoint; event subscriptions are changed in the GitHub
App's Permissions & events settings.

## Trust boundaries

- Cloudflare owns public DNS and edge transport; the explicit hostname avoids
  changing the existing Railway service.
- Caddy admits the public hostname and proxies to loopback. Port 42069 is not a
  public webhook URL.
- GitHub's delivery signature is checked over exact bytes before JSON parsing.
- The provider delivery GUID is the durable ingress identity, so redelivery is
  deduplicated before Speaker dispatch.
- Operational receipts redact the Managed Chat identifier, credential paths,
  authorization headers, payload bodies, and webhook signatures.

## Operational checks

These checks expose no credentials:

```sh
dig +short ambient-agent.co-worker.tech A

curl -sS -o /dev/null -w '%{http_code}\n' \
  -X POST -H 'Content-Type: application/json' --data '{}' \
  https://ambient-agent.co-worker.tech/channels/github/webhook
# 401: the public route reached the application signature gate

sudo caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile
sudo systemctl is-active caddy
curl -fsS http://127.0.0.1:42069/health
```

GitHub App delivery inspection uses an App JWT and the read-only
`GET /app/hook/deliveries` endpoint. Print only delivery GUID, event, action,
delivery time, status, and HTTP status. Never print request/response payloads or
headers.

The pre-#174 Caddy configuration is retained on the rig as
`/etc/caddy/Caddyfile.before-issue174-20260718`. Rollback removes the explicit
Cloudflare record, restores that file, reloads Caddy, and removes the dedicated
443 firewall allowance. Do not remove or modify the existing Railway records.

## Live GitHub deliveries

No locally signed or synthetic payload qualifies for this section.

### `issues.opened` -> broadcast Speaker dispatch

A real public proof issue was opened and then closed after capture:
[issue #219](https://github.com/AaronAbuUsama/ambient-agent/issues/219).
GitHub recorded the following App delivery:

```json
{
  "deliveryId": "3831983788892626944",
  "guid": "38ee792a-82e7-11f1-959e-7ce606dfe5da",
  "event": "issues",
  "action": "opened",
  "deliveredAt": "2026-07-18T20:28:24.082Z",
  "status": "OK",
  "statusCode": 200,
  "redelivery": false,
  "repository": "AaronAbuUsama/ambient-agent",
  "subjectNumber": 219
}
```

The same provider GUID settled as `done` in
`github_ingress_deliveries` at `2026-07-18T20:28:24.031Z`, with no error. The
redacted runtime receipt reported `broadcastChats: 1`, ambience `ambience`, and
dispatch ID `e097f4af-cfd7-4d9b-9c1a-595d83cc4c1d` while Speaker was online.
The Managed Chat identifier is deliberately omitted.

### `pull_request_review.submitted` -> normalized continuation ingress

The Ambient Reviewer GitHub App submitted a real formal COMMENT review on
[PR #220](https://github.com/AaronAbuUsama/ambient-agent/pull/220#pullrequestreview-4729260550).
GitHub recorded the following Planner App delivery:

```json
{
  "deliveryId": "3831984735175843840",
  "guid": "3f781e76-82e8-11f1-8c7d-ccb0b3399168",
  "event": "pull_request_review",
  "action": "submitted",
  "deliveredAt": "2026-07-18T20:35:44.777Z",
  "status": "OK",
  "statusCode": 200,
  "redelivery": false,
  "repository": "AaronAbuUsama/ambient-agent",
  "subjectNumber": 220
}
```

The same provider GUID settled as `done` in
`github_ingress_deliveries` at `2026-07-18T20:35:44.729Z`, with no error and
dispatch ID `65b2912c-bd26-4900-a61c-5c5b1f42c1a7`. The corresponding durable
Speaker submission (sequence 74) settled without error after its input was
applied. Redacted SQL predicates confirmed that its payload contains all four
continuation-ingress identities without printing the payload:

```json
{
  "has_normalized_type": true,
  "normalized_type": "github.pull-request-review.submitted",
  "has_delivery_guid": true,
  "has_public_repository": true,
  "has_pull_number": true
}
```
