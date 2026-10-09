#!/usr/bin/env bash
set -euo pipefail

OWNER="Extalia-VO"
PROJECT_TITLE="Extalia Roadmap & Engineering Board"

echo "Creating GitHub Project Board for $OWNER..."

PROJECT_NUM=$(gh project create --owner "$OWNER" --title "$PROJECT_TITLE" --format json --jq '.number' 2>/dev/null || true)

if [ -n "$PROJECT_NUM" ]; then
  echo "Project created with number: $PROJECT_NUM"
  echo "Linking repository Extalia-VO/extalia-virtual-agent..."
  gh project link "$PROJECT_NUM" --owner "$OWNER" --repo "extalia-virtual-agent" || true
else
  echo "Could not create project automatically. Ensure the authenticated account has Project Admin permissions in $OWNER."
fi
