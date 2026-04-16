#!/bin/sh

# ── Agent config protection ──────────────────────────────────
# Check if SOUL.md files exist for all agents. If any are missing,
# restore from the on-volume backup.
AGENTS="nexus engineering-lead creative-lead business-lead ops-lead dev-orchestrator design-orchestrator infra-orchestrator qa-orchestrator"
MISSING=0

for agent in $AGENTS; do
  if [ ! -f "/data/workspace/$agent/SOUL.md" ]; then
    echo "[fly-entrypoint] SOUL.md missing for $agent"
    MISSING=1
  fi
done

if [ "$MISSING" = "1" ] && [ -d "/data/workspace-backup" ]; then
  echo "[fly-entrypoint] Restoring agent configs from backup..."
  for agent in $AGENTS; do
    if [ -d "/data/workspace-backup/$agent" ]; then
      mkdir -p "/data/workspace/$agent"
      cp -a "/data/workspace-backup/$agent/SOUL.md" "/data/workspace/$agent/SOUL.md" 2>/dev/null || true
      cp -a "/data/workspace-backup/$agent/AGENTS.md" "/data/workspace/$agent/AGENTS.md" 2>/dev/null || true
    fi
  done
  chown -R node:node /data/workspace/ 2>/dev/null || true
  echo "[fly-entrypoint] Agent configs restored"
elif [ "$MISSING" = "1" ]; then
  echo "[fly-entrypoint] WARNING: Agent configs missing and no backup found"
fi

# Snapshot current configs as the backup for next boot
if [ -f "/data/workspace/nexus/SOUL.md" ]; then
  rm -rf /data/workspace-backup 2>/dev/null || true
  mkdir -p /data/workspace-backup
  for agent in $AGENTS; do
    if [ -d "/data/workspace/$agent" ]; then
      mkdir -p "/data/workspace-backup/$agent"
      cp -a "/data/workspace/$agent/SOUL.md" "/data/workspace-backup/$agent/SOUL.md" 2>/dev/null || true
      cp -a "/data/workspace/$agent/AGENTS.md" "/data/workspace-backup/$agent/AGENTS.md" 2>/dev/null || true
    fi
  done
  echo "[fly-entrypoint] Agent config backup updated"
fi

# ── Fix permissions ──────────────────────────────────────────
chown -R node:node /data/workspace/ 2>/dev/null || true
chown -R node:node /data/workspace-backup/ 2>/dev/null || true
chown -R node:node /data/identity/ 2>/dev/null || true

# ── Clear stale locks ────────────────────────────────────────
rm -f /data/gateway.*.lock
echo "[fly-entrypoint] Stale locks cleared"

# ── Start gateway ────────────────────────────────────────────
exec node dist/index.js gateway --allow-unconfigured --port 3000 --bind lan
