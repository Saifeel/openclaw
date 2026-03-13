---
summary: "Migrate a Dockerized OpenClaw gateway to a host-run systemd service while keeping tool execution containerized."
read_when:
  - You want the gateway on the host instead of in Docker
  - You still want Docker-backed tool execution
title: "Host Run VPS Migration"
---

# Host Run VPS Migration

Goal: run OpenClaw directly on the VPS host while keeping tool execution in Docker containers.

## Why use this model

- The gateway is no longer an internet-facing container with `docker.sock` mounted into it.
- Tool execution remains containerized.
- Logs, env, and process supervision become simpler on single-purpose VPS hosts.

## Phase 1 inventory

Before cutover, capture the current runtime contract:

- gateway bind and port
- auth token and related env
- relay env
- state directories
- mounted paths
- Docker dependencies needed for tool execution
- health checks
- restart behavior

For a Docker Compose deployment, record:

- service command
- published ports
- bind mounts
- environment variables
- health check command

## Phase 2 prepare host-run OpenClaw

Recommended approach for a VPS checkout:

- keep a checked-out repo on the host
- build it with the repo toolchain
- run the gateway from the built output:

```bash
node dist/index.js gateway --bind loopback --port 18789
```

Requirements:

- Node 22+
- `pnpm` available on the host user `PATH`
- built `dist/`
- built `dist/control-ui`
- a chosen service user
- Docker available on the host for tool containers

## Phase 3 move config out of the container

Put runtime env in a host-managed file such as:

```text
/etc/openclaw/openclaw-gateway.env
```

At minimum preserve:

- `OPENCLAW_GATEWAY_TOKEN`
- `OPENCLAW_GATEWAY_BIND`
- `OPENCLAW_GATEWAY_PORT`
- `RESEARCH_RELAY_ENABLED`
- `RESEARCH_UPSTREAM_URL`
- `RESEARCH_SHARED_TOKEN`
- `RESEARCH_ACTOR_ID`
- `RESEARCH_REQUEST_TIMEOUT_SEC`
- `RESEARCH_EXPERIMENT_EXECUTE_TIMEOUT_SEC`
- `RESEARCH_MAX_TOPIC_LEN`
- `RESEARCH_MAX_LABEL_LEN`

Suggested templates:

- `scripts/systemd/openclaw-gateway-host.env.example`
- `scripts/systemd/openclaw-gateway-host.service.example`

## Phase 4 create the systemd service

Recommended service model:

- system service on a dedicated VPS
- service user with Docker access only if tool containers require it
- `WorkingDirectory` set to the repo checkout
- env loaded from a locked-down host file
- restart on failure

The example unit in this repo uses:

- `WorkingDirectory` pointing at the checked-out repo
- `EnvironmentFile=/etc/openclaw/openclaw-gateway.env`
- `ExecStart=/usr/bin/node dist/index.js gateway ...`
- write access only to the OpenClaw state directory, not to the repo checkout

## Recommended cutover path

1. Make `pnpm` available on the host user `PATH`.
2. Build the repo and the Control UI assets on the host.
3. Create the host env file from the example template.
4. Install the example systemd unit with production paths adjusted.
5. Start the host-run gateway on an alternate port first.
6. Verify parity with the Dockerized gateway using authenticated relay routes such as `/research/health`, `/research/jobs`, and `/research/completions`.
7. Cut over the real port once parity is confirmed.
8. Leave the Docker gateway stopped and keep the Compose path only as rollback material until the host-run service has proven stable.
9. Recheck loopback binding, relay health, and the absence of new public-facing ports.

## Risks to watch

- config drift between Docker env and host env
- Docker permissions being broader than needed
- path assumptions that were previously hidden by container mounts
- accidental wider exposure if host bind settings differ from the current loopback setup

## Related docs

- [Setup](/start/setup)
- [Getting Started](/start/getting-started)
- [Docker Install](/install/docker)
