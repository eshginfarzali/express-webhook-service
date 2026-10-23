#!/usr/bin/env bash
# Starts the given image, waits for /health to report ok, then removes the container.
# Usage: scripts/docker-smoke.sh <image> [host-port]
set -euo pipefail

IMAGE="${1:?usage: $0 <image> [host-port]}"
HOST_PORT="${2:-3300}"
NAME="webhook-smoke-$$"

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --name "$NAME" --init --read-only --tmpfs /tmp \
  --mount type=tmpfs,destination=/app/data,tmpfs-mode=1777 \
  -p "127.0.0.1:${HOST_PORT}:3300" \
  -e WEBHOOK_SECRETS="smoke:smoke-test-secret-0123456789" \
  -e ADMIN_API_TOKEN="smoke-test-admin-token-0123456789" \
  "$IMAGE" >/dev/null

for _ in $(seq 1 30); do
  if body="$(curl -fsS "http://127.0.0.1:${HOST_PORT}/health" 2>/dev/null)"; then
    echo "health: ${body}"
    echo "user: $(docker exec "$NAME" id -un)"
    exit 0
  fi
  sleep 1
done

echo "service did not become healthy" >&2
docker logs "$NAME" >&2 || true
exit 1
