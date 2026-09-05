#!/usr/bin/env bash
#
# End-to-end smoke test: build the app, start it, and prove the primary entry
# point answers. Must pass on a clean checkout with LLM_PROVIDER=mock and no
# ANTHROPIC_API_KEY — CI never has a key.
#
# Usage: bash scripts/smoke.sh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Default to the deterministic, zero-network provider. An operator can override
# by exporting LLM_PROVIDER before invoking this script.
export LLM_PROVIDER="${LLM_PROVIDER:-mock}"
export NODE_ENV=production
export NEXT_TELEMETRY_DISABLED=1

SERVER_PID=""

cleanup() {
  local status=$?
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "[smoke] stopping server (pid $SERVER_PID)"
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

if [[ ! -d node_modules ]]; then
  echo "[smoke] node_modules missing — installing"
  if [[ -f package-lock.json ]]; then
    npm ci
  else
    npm install
  fi
fi

echo "[smoke] building"
npm run build

# Ask the OS for a free port rather than guessing one, so concurrent runs and
# busy dev machines do not collide.
PORT="$(node -e '
  const net = require("node:net");
  const server = net.createServer();
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    server.close(() => process.stdout.write(String(port)));
  });
')"
echo "[smoke] starting server on port $PORT"

npx next start --port "$PORT" --hostname 127.0.0.1 >/tmp/creator-os-smoke.log 2>&1 &
SERVER_PID=$!

HEALTH_URL="http://127.0.0.1:${PORT}/api/health"

# Bounded polling — never an unbounded wait.
ready=0
for attempt in $(seq 1 60); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "[smoke] server exited before becoming ready; log follows:" >&2
    cat /tmp/creator-os-smoke.log >&2
    exit 1
  fi
  if curl --silent --fail --max-time 2 "$HEALTH_URL" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.5
done

if [[ "$ready" -ne 1 ]]; then
  echo "[smoke] server did not answer $HEALTH_URL within 30s; log follows:" >&2
  cat /tmp/creator-os-smoke.log >&2
  exit 1
fi

echo "[smoke] GET $HEALTH_URL"
BODY="$(curl --silent --fail --max-time 5 "$HEALTH_URL")"
echo "[smoke] response: $BODY"

# Assert on the payload, not just the status code.
node -e '
  const body = JSON.parse(process.argv[1]);
  if (body.ok !== true) throw new Error("health payload has ok !== true");
  if (typeof body.provider !== "string" || !body.provider) throw new Error("health payload missing provider");
  if (typeof body.model !== "string" || !body.model) throw new Error("health payload missing model");
' "$BODY"

echo "[smoke] PASS"
exit 0
