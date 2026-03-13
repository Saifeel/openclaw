# Host-Run OpenClaw Gateway Install Runbook

Target choices for this VPS:

- service user: `saifeel`
- repo path: `/home/saifeel/openclaw`
- service type: system service

## 1. Prepare host env file

Create the env directory:

```bash
sudo mkdir -p /etc/openclaw
```

Copy the example env file:

```bash
sudo cp scripts/systemd/openclaw-gateway-host.env.example /etc/openclaw/openclaw-gateway.env
```

Edit it and set the real secrets:

```bash
sudo editor /etc/openclaw/openclaw-gateway.env
```

Lock permissions:

```bash
sudo chown root:root /etc/openclaw/openclaw-gateway.env
sudo chmod 600 /etc/openclaw/openclaw-gateway.env
```

## 2. Install the systemd service

Copy the example unit:

```bash
sudo cp scripts/systemd/openclaw-gateway-host.service.example /etc/systemd/system/openclaw-gateway-host.service
```

Reload systemd:

```bash
sudo systemctl daemon-reload
```

Enable the service:

```bash
sudo systemctl enable openclaw-gateway-host.service
```

## 3. Build the host checkout before first start

Make the `pnpm` shim visible for the current user:

```bash
mkdir -p "$HOME/.local/bin"
corepack enable --install-directory "$HOME/.local/bin" pnpm
export PATH="$HOME/.local/bin:$PATH"
hash -r
```

Build the gateway and Control UI assets from the checked-out repo:

```bash
cd /home/saifeel/openclaw
pnpm build
pnpm ui:build
```

## 4. Start on an alternate port first

Before production cutover, temporarily set this in `/etc/openclaw/openclaw-gateway.env`:

```text
OPENCLAW_GATEWAY_PORT=18889
```

Then start:

```bash
sudo systemctl start openclaw-gateway-host.service
```

Check status:

```bash
sudo systemctl status openclaw-gateway-host.service --no-pager
journalctl -u openclaw-gateway-host.service -n 100 --no-pager
```

## 5. Verify host-run parity

Recommended parity checks:

```bash
curl -sS -H "Authorization: Bearer <gateway-token>" -H "x-openclaw-research-token: <worker-token>" http://127.0.0.1:18889/research/health
curl -sS -H "Authorization: Bearer <gateway-token>" -H "x-openclaw-research-token: <worker-token>" http://127.0.0.1:18889/research/jobs?limit=3
curl -sS -H "Authorization: Bearer <gateway-token>" -H "x-openclaw-research-token: <worker-token>" http://127.0.0.1:18889/research/completions?limit=3
```

Use `systemctl status` for the service-level health check. In this deployment, plain
`/health`, `/healthz`, `/ready`, and `/readyz` are not useful parity probes because the
Control UI responds on those paths.

## 6. Cut over production port

When parity is confirmed:

1. stop the Dockerized gateway
2. set `OPENCLAW_GATEWAY_PORT=18789` in the host env file
3. restart the host service

Suggested sequence:

```bash
cd /home/saifeel/openclaw
docker compose stop openclaw-gateway
sudo editor /etc/openclaw/openclaw-gateway.env
sudo systemctl restart openclaw-gateway-host.service
sudo systemctl status openclaw-gateway-host.service --no-pager
```

## 7. Retire the old wrapper path

Once the host-run gateway is stable on `18789`, leave the Docker gateway stopped:

```bash
cd /home/saifeel/openclaw
docker compose ps
```

Expected:

- no running `openclaw-gateway` container

Keep the Compose definition only as rollback material until the host-run service has been
stable long enough for you to trust the new path.

## 8. Post-cutover hardening

Confirm the final operating model stays narrow:

```bash
sudo systemctl status openclaw-gateway-host.service --no-pager --lines=40
curl -sS -H "Authorization: Bearer <gateway-token>" -H "x-openclaw-research-token: <worker-token>" http://127.0.0.1:18789/research/health
curl -sS -H "Authorization: Bearer <gateway-token>" -H "x-openclaw-research-token: <worker-token>" http://127.0.0.1:18789/research/jobs?limit=3
```

Recheck these constraints:

- host-run gateway still binds to loopback
- worker upstream remains the private Tailscale URL
- no new public-facing ports were opened
- Docker gateway stays stopped
- the host-run service only needs write access to `/home/saifeel/.openclaw`

## 9. Roll back if needed

```bash
sudo systemctl stop openclaw-gateway-host.service
cd /home/saifeel/openclaw
docker compose start openclaw-gateway
docker compose ps openclaw-gateway
```
