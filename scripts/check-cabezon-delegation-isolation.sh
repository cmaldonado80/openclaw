#!/bin/bash
# Targeted regression check for deterministic Cabezón delegation
# Ensures cross-agent recovery uses context:"isolated" (not "fork")
# This survives OpenClaw core upgrades by detecting if hot patch was overwritten.
#
# LIMITATION (reported per task): Source equivalent of startDeterministicCabezonDelegation
# not found in /Users/cmaldonado/openclaw via rg/project patterns or initial parent grep.
# The function lives only in the bundled dist/embedded-agent-*.js of the installed package.
# No source TS patch possible; hot patch + this check is the enforcement.
#
# Usage: bash scripts/check-cabezon-delegation-isolation.sh
# Run after any openclaw upgrade or gateway restart to verify.
#
# Part of workspace-platform-control hardening for Cabezón delegation.

set -euo pipefail

INSTALLED_DIR="/opt/homebrew/lib/node_modules/openclaw"
BACKUP_DIR="/Users/cmaldonado/.openclaw/backups/openclaw-core-hotpatch-20260615-072622"

echo "=== Cabezón Deterministic Delegation Isolation Check ==="
echo "Date: $(date)"
echo "Installed: $INSTALLED_DIR"

if [ ! -d "$INSTALLED_DIR" ]; then
  echo "FAIL: Installed OpenClaw not found at $INSTALLED_DIR"
  exit 1
fi

# Find the embedded-agent file containing the delegation function
EMBEDDED_AGENT=""
for f in "$INSTALLED_DIR"/dist/embedded-agent-*.js; do
  if [ -f "$f" ] && grep -q 'startDeterministicCabezonDelegation' "$f" 2>/dev/null; then
    EMBEDDED_AGENT="$f"
    break
  fi
done

ISOLATED_OK=0

if [ -n "$EMBEDDED_AGENT" ]; then
  echo "Found legacy delegation wrapper: $EMBEDDED_AGENT"

  # Verify the isolation context in the legacy hot-patch path
  if grep -q 'context: "isolated"' "$EMBEDDED_AGENT"; then
    echo "PASS: context: \"isolated\" present in startDeterministicCabezonDelegation"
    ISOLATED_OK=1
  else
    echo "FAIL: context: \"isolated\" NOT found — hot patch likely lost on upgrade"
    echo "Root cause reminder: sessions_spawn rejects cross-agent context:\"fork\""
  fi
else
  echo "INFO: Legacy startDeterministicCabezonDelegation wrapper not found (expected on 2026.6.8+)"

  # On 2026.6.8+ the runtime enforces cross-agent isolation natively in the sessions_spawn handler.
  NATIVE_ENFORCEMENT_FILE=""
  for f in "$INSTALLED_DIR"/dist/openclaw-tools-*.js; do
    if [ -f "$f" ] && grep -q 'requires the same target agent as the requester; use context=' "$f" 2>/dev/null; then
      NATIVE_ENFORCEMENT_FILE="$f"
      break
    fi
  done

  if [ -n "$NATIVE_ENFORCEMENT_FILE" ]; then
    echo "PASS: Native runtime enforcement found in $(basename "$NATIVE_ENFORCEMENT_FILE")"
    echo "      Cross-agent sessions_spawn with context=\"fork\" is rejected; context=\"isolated\" is required."
    ISOLATED_OK=1
  else
    echo "FAIL: Neither legacy hot patch nor native runtime enforcement found"
    echo "      Cross-agent delegation isolation cannot be verified."
  fi
fi

# Optional: check backup still exists
if [ -f "$BACKUP_DIR/embedded-agent-CNx4pY65.js.bak" ]; then
  echo "INFO: Original backup preserved at $BACKUP_DIR"
else
  echo "WARN: Backup not found (may have been cleaned)"
fi

# Source limitation note
echo ""
echo "SOURCE LIMITATION:"
echo "  - startDeterministicCabezonDelegation not located in source repo"
echo "  - No TS/JS source file found via rg for 'startDeterministicCabezonDelegation', 'deterministic.*Cabezon', or related delegation/fork/isolated patterns in src/, packages/, scripts/"
echo "  - For 2026.6.1: installed hot patch + this check is the enforcement"
echo "  - For 2026.6.8+: native runtime enforcement in openclaw-tools-*.js replaces the hot patch"
echo "  - Future upgrades: re-apply hot patch (legacy) or verify native enforcement (current)"

if [ "$ISOLATED_OK" -eq 1 ]; then
  echo ""
  echo "STATUS: PASS - deterministic Cabezón delegation is upgrade-safe (isolated context enforced)"
  exit 0
else
  echo ""
  echo "STATUS: FAIL - cross-agent delegation isolation cannot be verified; manual review required"
  exit 1
fi
