#!/usr/bin/env bash
# Install the Sensei server as a systemd *user* service that starts on boot and restarts on
# crashes. Run from anywhere:  bash deploy/install-service.sh
# Undo:  systemctl --user disable --now sensei && rm ~/.config/systemd/user/sensei.service
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UV="$(command -v uv || echo "$HOME/.local/bin/uv")"
PORT="${SENSEI_PORT:-8000}"
UNIT_DIR="$HOME/.config/systemd/user"

ENV="$REPO/server/.env"
[[ -f "$ENV" ]] || cp "$REPO/server/.env.example" "$ENV"
if ! grep -q '^SENSEI_API_TOKEN=.\{16,\}' "$ENV"; then
  sed -i '/^SENSEI_API_TOKEN=/d' "$ENV"
  echo "SENSEI_API_TOKEN=$(openssl rand -hex 24)" >> "$ENV"
  echo "Generated an API token in server/.env. Paste it into the extension + web app settings:"
  echo "  grep SENSEI_API_TOKEN $ENV"
fi

mkdir -p "$UNIT_DIR"
cat > "$UNIT_DIR/sensei.service" <<UNIT
[Unit]
Description=Japanese Ultimate Sensei server
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=$REPO/server
ExecStart=$UV run --frozen uvicorn app.main:create_app --factory --host 0.0.0.0 --port $PORT
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
UNIT

systemctl --user daemon-reload
systemctl --user enable --now sensei
# Without lingering, user services only run while you're logged in.
if [[ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != "yes" ]]; then
  echo "To start on boot without logging in, run once:  sudo loginctl enable-linger $USER"
fi
sleep 2
systemctl --user --no-pager status sensei | head -5
curl -fsS "http://localhost:$PORT/health" && echo
