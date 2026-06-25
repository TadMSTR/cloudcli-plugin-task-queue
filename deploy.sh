#!/usr/bin/env bash
# Build and deploy the plugin to CloudCLI's plugins directory.
# Usage: ./deploy.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$HOME/.claude-code-ui/plugins/cloudcli-plugin-task-queue"
API="http://localhost:3001/api/plugins/task-queue"

# Load CLOUDCLI_API_KEY from forge secrets
FORGE_ENV="$HOME/.secrets/forge.env"
if [ -f "$FORGE_ENV" ]; then
  set -a; source "$FORGE_ENV"; set +a
fi
if [ -z "${CLOUDCLI_API_KEY:-}" ]; then
  echo "[task-queue] ERROR: CLOUDCLI_API_KEY not set — add it to ~/.secrets/forge.env" >&2
  exit 1
fi
AUTH_HEADER="X-API-Key: $CLOUDCLI_API_KEY"

echo "[task-queue] Building..."
cd "$REPO_DIR"
npm run build

echo "[task-queue] Deploying to $PLUGIN_DIR..."
# Disable plugin to stop the server
curl -sf -X PUT "$API/enable" -H "Content-Type: application/json" -H "$AUTH_HEADER" -d '{"enabled":false}' > /dev/null 2>&1 || true
sleep 1

rm -rf "$PLUGIN_DIR"
mkdir -p "$PLUGIN_DIR/dist"
cp "$REPO_DIR/manifest.json" "$REPO_DIR/package.json" "$REPO_DIR/icon.svg" "$PLUGIN_DIR/"
cp -r "$REPO_DIR/dist/"* "$PLUGIN_DIR/dist/"
if [ -d "$REPO_DIR/node_modules" ]; then
  cp -r "$REPO_DIR/node_modules" "$PLUGIN_DIR/node_modules"
fi

# Re-enable to start the server
curl -sf -X PUT "$API/enable" -H "Content-Type: application/json" -H "$AUTH_HEADER" -d '{"enabled":true}' > /dev/null 2>&1
sleep 2

# Verify
STATUS=$(curl -sf "http://localhost:3001/api/plugins" -H "$AUTH_HEADER" 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); p=[x for x in d.get('plugins',[]) if x['name']=='task-queue']; print(f\"running={p[0]['serverRunning']}\" if p else 'not found')" 2>/dev/null || echo "verify failed — check CloudCLI")
echo "[task-queue] Status: $STATUS"
echo "[task-queue] Done."
