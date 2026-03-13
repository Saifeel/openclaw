# OpenClaw Host-Run Migration Todo

Goal:

- Run OpenClaw directly on the VPS host
- Keep tool execution containerized
- Keep the local research worker remote over Tailscale
- Remove the current "internet-facing OpenClaw container with docker.sock mounted" model

## Phase 1: Inventory Current State

Current status:

- In progress
- Findings captured:
  - current gateway runs as `openclaw-gateway` in Docker Compose
  - current runtime command is `node dist/index.js gateway --bind loopback --port 18789`
  - current host binds are loopback ports `18789`, `18790`, and `18791`
  - current persistent state mounts are `~/.openclaw` and `~/.openclaw/workspace`
  - current tool execution path depends on `/var/run/docker.sock` and `/usr/bin/docker`
  - current relay env is present and working
- Record current Docker Compose behavior
- Record current image/tag and container runtime settings
- Record current env/config values needed for gateway auth, relay, channels, and providers
- Record mounted volumes and paths that OpenClaw depends on
- Record restart/update/health-check behavior
- Confirm how tool execution currently depends on Docker from the running setup

Definition of done:

- We have a clear list of everything the host-run service must reproduce

## Phase 2: Prepare Host-Run OpenClaw

Current status:

- In progress
- Findings captured:
  - Node 22 is already available on the host
  - there is no existing host `openclaw` binary installed
  - `pnpm` was installed on the service user PATH via a user-local corepack shim
  - the practical host-run path is to run from the checked-out repo with `node dist/index.js`
  - chosen service user: `saifeel`
  - chosen repo path: `/home/saifeel/openclaw`
  - chosen service type: system service
  - host checkout now builds successfully with `pnpm build` and `pnpm ui:build`
- Confirm Node 22+ is available on the VPS host
- Decide whether to run from npm install or from the checked-out repo/build
- Choose the service user for host-run OpenClaw
- Create/confirm host paths for config, workspace, logs, sessions, and credentials
- Ensure the host runtime can read the same config and env values as the containerized setup

Definition of done:

- OpenClaw can be started directly on the host in a controlled test mode

## Phase 3: Move Gateway Config Out Of Container

Current status:

- In progress
- Templates prepared:
  - `scripts/systemd/openclaw-gateway-host.env.example`
- Host env installed on VPS:
  - `/etc/openclaw/openclaw-gateway.env`
- Current test mode:
  - host-run gateway uses loopback on alternate port `18889`
- Move required gateway env/config into host-managed files
- Preserve gateway auth token
- Preserve relay config:
  - `RESEARCH_RELAY_ENABLED`
  - `RESEARCH_UPSTREAM_URL`
  - `RESEARCH_SHARED_TOKEN`
  - `RESEARCH_ACTOR_ID`
  - `RESEARCH_REQUEST_TIMEOUT_SEC`
  - `RESEARCH_EXPERIMENT_EXECUTE_TIMEOUT_SEC`
  - `RESEARCH_MAX_TOPIC_LEN`
  - `RESEARCH_MAX_LABEL_LEN`
- Preserve any channel/provider credentials and runtime flags
- Lock down permissions on host env/config files

Definition of done:

- Host-run OpenClaw has the same effective config as the current containerized gateway

## Phase 4: Create Host Service

Current status:

- In progress
- Templates prepared:
  - `scripts/systemd/openclaw-gateway-host.service.example`
- Host service installed on VPS:
  - `openclaw-gateway-host.service`
- Current test mode:
  - host-run gateway is active under `systemd` on loopback port `18889`
- Create a `systemd` service for the OpenClaw gateway
- Configure restart-on-failure
- Configure startup on boot
- Configure service user/group
- Configure environment file loading
- Configure logging to journal and/or dedicated log path
- Bind only where intended

Definition of done:

- OpenClaw can be managed with `systemctl` instead of Docker Compose

## Phase 5: Preserve Containerized Tool Execution

- Keep Docker available for tool/sandbox execution
- Ensure host-run OpenClaw has the minimum Docker access required
- Preserve tool isolation while avoiding broad host mounts
- Keep tool containers unprivileged unless explicitly required
- Avoid host networking by default
- Apply resource limits where practical
- Prefer read-only filesystems and dropped capabilities where possible

Definition of done:

- Tools still run in containers, but the gateway itself no longer does

## Phase 6: Parallel Smoke Before Cutover

- Current status:
  - In progress
  - Verified on host-run `18889`:
    - `/research/health`
    - `/research/completions`
    - `/research/jobs`
    - `/research/submit`
    - `/research/status/:job_id`
    - `/research/result/:job_id`
    - `/research/artifacts/:job_id`
  - Still to verify:
    - parity against the Dockerized gateway under the same worker load, only if you want a final side-by-side before cutover
- Start host-run OpenClaw on an alternate port
- Verify gateway auth works
- Verify relay routes:
  - `/research/health`
  - `/research/jobs`
  - `/research/completions`
  - `/research/submit`
  - `/research/status/:job_id`
  - `/research/result/:job_id`
  - `/research/artifacts/:job_id`
- Verify tool execution path
- Compare behavior with the current Dockerized gateway

Definition of done:

- Host-run instance matches current production behavior closely enough for cutover

## Phase 7: Cutover

- Stop the containerized gateway
- Start the host-run service on the real production port
- Verify gateway health
- Verify local worker relay
- Verify tool execution
- Verify auth and expected command flows

Definition of done:

- Production traffic is served by host-run OpenClaw

## Phase 8: Remove Old Wrapper

- Disable the old gateway container
- Remove the old container path from active operations
- Remove the old `docker.sock` mount from the public-facing gateway path
- Keep rollback notes until the new setup is stable

Definition of done:

- There is no ambiguous dual-runtime setup left behind

## Phase 9: Post-Migration Hardening

- Recheck firewall exposure
- Recheck bind settings
- Recheck Docker access scope
- Recheck logs and restart behavior
- Remove stale secrets/env files from the old container flow
- Document the final operating model and recovery steps

Definition of done:

- The new host-run setup is operationally documented and hardened

## Recommended Execution Order

1. Complete Phase 1 inventory
2. Prepare the host runtime
3. Move env/config
4. Create the host service
5. Validate on an alternate port
6. Cut over
7. Retire the old wrapper
8. Harden and document

## Biggest Risks

- Config drift between Docker env and host env
- Tool-launch behavior changing when OpenClaw no longer runs in a container
- Path assumptions baked into the current containerized setup
- Accidentally exposing a wider bind/port surface during cutover

## Rollback Plan

- Keep the current Dockerized gateway intact until host-run parity is proven
- If host-run cutover fails:
  - stop the host service
  - restart the Dockerized gateway
  - verify health and relay behavior
