#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WATCHDOG_SCRIPT="$ROOT_DIR/scripts/research-relay-watchdog.sh"
LOG_DIR="${LOG_DIR:-$HOME/.openclaw/relay-watchdog}"
mkdir -p "$LOG_DIR"

if command -v crontab >/dev/null 2>&1; then
  (
    crontab -l 2>/dev/null | grep -v 'research-relay-watchdog.sh' || true
    echo "*/2 * * * * cd $ROOT_DIR && $WATCHDOG_SCRIPT >/dev/null 2>&1"
  ) | crontab -
  echo "Installed cron watchdog: every 2 minutes"
  crontab -l | grep 'research-relay-watchdog.sh' || true
  exit 0
fi

if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  USER_SYSTEMD_DIR="$HOME/.config/systemd/user"
  mkdir -p "$USER_SYSTEMD_DIR"
  SERVICE_FILE="$USER_SYSTEMD_DIR/research-relay-watchdog.service"
  TIMER_FILE="$USER_SYSTEMD_DIR/research-relay-watchdog.timer"

  cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Research relay watchdog (one-shot)

[Service]
Type=oneshot
WorkingDirectory=$ROOT_DIR
ExecStart=$WATCHDOG_SCRIPT
EOF

  cat > "$TIMER_FILE" <<'EOF'
[Unit]
Description=Run research relay watchdog every 2 minutes

[Timer]
OnBootSec=1min
OnUnitActiveSec=2min
AccuracySec=30s
Persistent=true

[Install]
WantedBy=timers.target
EOF

  systemctl --user daemon-reload
  systemctl --user enable --now research-relay-watchdog.timer
  echo "Installed systemd user timer watchdog: every 2 minutes"
  systemctl --user status research-relay-watchdog.timer --no-pager || true
  exit 0
fi

echo "No cron or user-systemd available in this environment."
echo "Run manually as needed:"
echo "  $WATCHDOG_SCRIPT"
exit 0
