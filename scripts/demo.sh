#!/usr/bin/env bash
# One-command demo: hub + agent host + UI, all from the repo root (`pnpm demo`).
# The host spawns the roster (adapters/roster.toml) into each room a browser opens.
# Ctrl-C tears all three down. Needs: a built JS workspace (pnpm install), a Python
# venv (.venv) with `.[agent]`, and ANTHROPIC_API_KEY for the default agents to reply.
set -euo pipefail
cd "$(dirname "$0")/.."

# .env holds the API keys (ANTHROPIC_API_KEY, optional GOOGLE_API_KEY/GOOGLE_CSE_ID, …).
# It is loaded ONLY into the agent host (below); the hub and the UI dev server are not
# given its values (anything already exported in your shell is inherited by every process,
# as usual). Hub settings (PORT, ABRA_HUB_HOST, ABRA_ALLOWED_ORIGINS) come from the real
# environment, e.g. `ABRA_HUB_HOST=0.0.0.0 pnpm demo` for a LAN demo.

trap 'kill 0' EXIT INT TERM  # Ctrl-C / exit kills the whole process group (hub + host + vite)

PY="${PYTHON:-.venv/bin/python}"

echo "[demo] starting hub on ws://localhost:8787"
node apps/hub/src/hub.js &

sleep 1  # let the hub bind before the host's control connection (the host also retries)
echo "[demo] starting agent host (roster: adapters/roster.toml)"
(
  if [ -f .env ]; then
    set -a  # auto-export every var .env sets, for this subshell only
    # shellcheck disable=SC1091
    . ./.env
    set +a
  fi
  exec "$PY" -m adapters.host
) &

echo "[demo] starting UI — open the printed URL"
# Do NOT `exec` here: exec replaces this shell and discards the trap above, which would
# orphan the backgrounded hub + host on Ctrl-C. Run in the foreground so the trap fires.
pnpm --filter demo dev
