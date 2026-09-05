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

# The health endpoint proves the process is up; it does not prove the product
# works. The real entry point is a raw idea going in and hooks plus a script
# coming out, so the smoke test exercises that path too — otherwise a
# generation loop that is broken end to end still smokes green.
GENERATE_URL="http://127.0.0.1:${PORT}/api/generate"
IDEA="Two sessions a week beats a five-day split you abandon by week three, and here is how I actually run mine."

echo "[smoke] POST $GENERATE_URL"
GEN_BODY="$(curl --silent --fail --max-time 120 \
  --header 'content-type: application/json' \
  --data "$(node -e 'process.stdout.write(JSON.stringify({ idea: process.argv[1], hookCount: 4 }))' "$IDEA")" \
  "$GENERATE_URL")"

node -e '
  const body = JSON.parse(process.argv[1]);
  if (body.ok !== true) throw new Error(`generate returned ok !== true: ${process.argv[1]}`);
  if (!Array.isArray(body.hooks) || body.hooks.length !== 4) {
    throw new Error(`expected 4 hooks, got ${body.hooks && body.hooks.length}`);
  }
  const angles = new Set(body.hooks.map((hook) => hook.angle));
  if (angles.size !== body.hooks.length) throw new Error("hooks repeat an angle");
  const kinds = (body.script?.sections ?? []).map((section) => section.kind);
  for (const required of ["hook", "body", "cta"]) {
    if (!kinds.includes(required)) throw new Error(`script is missing its ${required} section`);
  }
' "$GEN_BODY"
echo "[smoke] generated ${IDEA:0:40}... -> 4 hooks + a complete script"

# A malformed request must be answered, not crash the server. This is the
# cheapest possible guard against the route throwing past its error mapping.
echo "[smoke] POST $GENERATE_URL with an empty idea (expecting 400)"
BAD_STATUS="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 10 \
  --header 'content-type: application/json' --data '{"idea":""}' "$GENERATE_URL")"
if [[ "$BAD_STATUS" != "400" ]]; then
  echo "[smoke] expected HTTP 400 for an empty idea, got $BAD_STATUS" >&2
  exit 1
fi

echo "[smoke] PASS"
exit 0
