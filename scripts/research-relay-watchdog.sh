#!/usr/bin/env bash
set -euo pipefail

# Relay watchdog for VPS-side gateway coordination.
# - Probes gateway /research/health with both gateway bearer + relay shared token
# - Tracks consecutive failures in a state file
# - Restarts gateway after threshold consecutive failures

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"
STATE_DIR="${STATE_DIR:-$HOME/.openclaw/relay-watchdog}"
STATE_FILE="$STATE_DIR/failures.count"
RESTART_HISTORY_FILE="${RESTART_HISTORY_FILE:-$STATE_DIR/restarts.log}"
LOG_FILE="${LOG_FILE:-$STATE_DIR/watchdog.log}"

CHECK_INTERVAL_SEC="${CHECK_INTERVAL_SEC:-0}"
FAILURE_THRESHOLD="${FAILURE_THRESHOLD:-3}"
GATEWAY_BASE="${GATEWAY_BASE:-http://127.0.0.1:18789}"
HEALTH_PATH="${HEALTH_PATH:-/research/health}"
TIMEOUT_SEC="${TIMEOUT_SEC:-10}"
ALERT_RESTART_THRESHOLD="${ALERT_RESTART_THRESHOLD:-3}"
ALERT_WINDOW_SEC="${ALERT_WINDOW_SEC:-1800}"

mkdir -p "$STATE_DIR"

ts() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

log() {
  local line
  line="$(ts) $*"
  echo "$line" | tee -a "$LOG_FILE"
}

record_restart_and_maybe_alert() {
  local now cutoff tmp_file recent_count
  now="$(date +%s)"
  cutoff="$((now - ALERT_WINDOW_SEC))"
  tmp_file="${RESTART_HISTORY_FILE}.tmp"
  touch "$RESTART_HISTORY_FILE"
  awk -v cutoff="$cutoff" '$1 >= cutoff { print $1 }' "$RESTART_HISTORY_FILE" > "$tmp_file"
  printf '%s\n' "$now" >> "$tmp_file"
  mv "$tmp_file" "$RESTART_HISTORY_FILE"

  recent_count="$(wc -l < "$RESTART_HISTORY_FILE" | tr -d '[:space:]')"
  if ! [[ "$recent_count" =~ ^[0-9]+$ ]]; then
    recent_count="0"
  fi
  if [[ "$recent_count" -ge "$ALERT_RESTART_THRESHOLD" ]]; then
    local alert_msg
    alert_msg="ALERT: gateway restarted $recent_count times in last ${ALERT_WINDOW_SEC}s"
    log "$alert_msg"
    if command -v logger >/dev/null 2>&1; then
      logger -t openclaw-relay-watchdog -- "$alert_msg" || true
    fi
  fi
}

read_env_value() {
  local key="$1"
  local value
  value="$(grep -E "^${key}=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true)"
  echo "$value"
}

write_failure_count() {
  printf '%s\n' "$1" > "$STATE_FILE"
}

read_failure_count() {
  if [[ -f "$STATE_FILE" ]]; then
    cat "$STATE_FILE"
    return
  fi
  echo "0"
}

if [[ ! -f "$ENV_FILE" ]]; then
  log "ERROR: missing env file: $ENV_FILE"
  exit 1
fi

RESEARCH_ENABLED="$(read_env_value RESEARCH_RELAY_ENABLED)"
if [[ "${RESEARCH_ENABLED,,}" != "true" && "$RESEARCH_ENABLED" != "1" ]]; then
  log "relay disabled (RESEARCH_RELAY_ENABLED=$RESEARCH_ENABLED); skipping"
  exit 0
fi

GATEWAY_TOKEN="$(read_env_value OPENCLAW_GATEWAY_TOKEN)"
RELAY_TOKEN="$(read_env_value RESEARCH_SHARED_TOKEN)"

if [[ -z "$GATEWAY_TOKEN" || -z "$RELAY_TOKEN" ]]; then
  log "ERROR: missing OPENCLAW_GATEWAY_TOKEN or RESEARCH_SHARED_TOKEN in $ENV_FILE"
  exit 1
fi

if [[ "$CHECK_INTERVAL_SEC" -gt 0 ]]; then
  sleep "$CHECK_INTERVAL_SEC"
fi

URL="${GATEWAY_BASE}${HEALTH_PATH}"
PROBE_OUTPUT="$(
  docker compose -f "$ROOT_DIR/docker-compose.yml" \
    exec -T \
    -e "OPENCLAW_GATEWAY_TOKEN=$GATEWAY_TOKEN" \
    -e "RESEARCH_SHARED_TOKEN=$RELAY_TOKEN" \
    openclaw-gateway \
    node -e '
      const url = process.env.WATCHDOG_URL ?? "http://127.0.0.1:18789/research/health";
      const timeoutMs = Number(process.env.WATCHDOG_TIMEOUT_MS || "10000");
      const token = process.env.OPENCLAW_GATEWAY_TOKEN || "";
      const relay = process.env.RESEARCH_SHARED_TOKEN || "";
      const ctrl = AbortSignal.timeout(timeoutMs);
      fetch(url, {
        headers: {
          authorization: "Bearer " + token,
          "x-openclaw-research-token": relay,
        },
        signal: ctrl,
      })
        .then(async (res) => {
          const body = await res.text();
          console.log(String(res.status));
          console.log(body);
        })
        .catch((err) => {
          console.log("000");
          console.log(String(err));
          process.exit(0);
        });
    ' 2>&1 || true
)"
HTTP_CODE="$(printf '%s\n' "$PROBE_OUTPUT" | sed -n '1p')"
BODY="$(printf '%s\n' "$PROBE_OUTPUT" | sed -n '2,$p')"

if [[ "$HTTP_CODE" == "200" ]]; then
  write_failure_count "0"
  log "ok health=200 url=$URL body=${BODY:0:240}"
  exit 0
fi

current_failures="$(read_failure_count)"
if ! [[ "$current_failures" =~ ^[0-9]+$ ]]; then
  current_failures="0"
fi
next_failures="$((current_failures + 1))"
write_failure_count "$next_failures"
log "fail health=$HTTP_CODE failures=$next_failures/$FAILURE_THRESHOLD url=$URL body=${BODY:0:240}"

if [[ "$next_failures" -lt "$FAILURE_THRESHOLD" ]]; then
  exit 0
fi

log "threshold reached -> restarting gateway"
if docker compose -f "$ROOT_DIR/docker-compose.yml" up -d openclaw-gateway >>"$LOG_FILE" 2>&1; then
  write_failure_count "0"
  log "restart succeeded; failure counter reset"
  record_restart_and_maybe_alert
else
  log "restart failed; leaving failure counter at $next_failures"
  exit 1
fi
