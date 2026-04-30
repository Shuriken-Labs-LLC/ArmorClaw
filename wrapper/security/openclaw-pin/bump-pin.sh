#!/usr/bin/env bash
# Bump the OpenClaw upstream pin to a new SHA.
#
# Usage: bump-pin.sh <new-sha>
#
# Validates the SHA exists upstream, prints a diff report scoped to
# OpenClaw-owned paths, prompts for confirmation, updates PINNED_SHA.txt,
# appends a section to SYNC_LOG.md.
#
# This script does NOT commit. The human runs `git add -A && git commit`
# with a message like "security: bump openclaw pin to <short-sha>".

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PIN_DIR="$REPO_ROOT/wrapper/security/openclaw-pin"
PIN_FILE="$PIN_DIR/PINNED_SHA.txt"
PATHS_FILE="$PIN_DIR/PATHS.json"
SYNC_LOG="$PIN_DIR/SYNC_LOG.md"
UPSTREAM_URL="${OPENCLAW_UPSTREAM_URL:-https://github.com/openclaw/openclaw.git}"
UPSTREAM_REMOTE="openclaw-upstream"

cd "$REPO_ROOT"

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <new-sha>" >&2
  exit 2
fi

NEW_SHA_INPUT="$1"

# Validate SHA format: 7-40 hex chars.
if ! printf '%s' "$NEW_SHA_INPUT" | grep -qE '^[0-9a-fA-F]{7,40}$'; then
  echo "ERROR: '$NEW_SHA_INPUT' is not a valid git SHA (expected 7-40 hex chars)" >&2
  exit 2
fi

# Ensure upstream remote.
if ! git remote get-url "$UPSTREAM_REMOTE" >/dev/null 2>&1; then
  git remote add "$UPSTREAM_REMOTE" "$UPSTREAM_URL"
fi

# Fetch and resolve.
if ! git cat-file -e "$NEW_SHA_INPUT^{commit}" 2>/dev/null; then
  if ! git fetch "$UPSTREAM_REMOTE" "$NEW_SHA_INPUT" --quiet 2>/dev/null; then
    git fetch "$UPSTREAM_REMOTE" --quiet 2>/dev/null || true
    if ! git cat-file -e "$NEW_SHA_INPUT^{commit}" 2>/dev/null; then
      echo "ERROR: cannot resolve $NEW_SHA_INPUT from $UPSTREAM_REMOTE ($UPSTREAM_URL)" >&2
      exit 2
    fi
  fi
fi

NEW_SHA="$(git rev-parse "$NEW_SHA_INPUT")"
NEW_SHORT="$(git rev-parse --short "$NEW_SHA")"

if [ ! -f "$PIN_FILE" ]; then
  echo "ERROR: pin file missing at $PIN_FILE" >&2
  exit 2
fi
FROM_SHA="$(tr -d '[:space:]' < "$PIN_FILE")"

if [ "$FROM_SHA" = "$NEW_SHA" ]; then
  echo "Pin already at $NEW_SHA — nothing to do."
  exit 0
fi

# Parse openclawPaths for diff report scoping.
parse_paths() {
  local key="$1"
  node -e "
    const p = require('$PATHS_FILE');
    for (const e of p['$key']) console.log(e);
  "
}
# bash 3.2-portable equivalent of `mapfile -t`.
read_lines_into() {
  local __array_name="$1"
  local __key="$2"
  local __line
  eval "$__array_name=()"
  while IFS= read -r __line; do
    eval "$__array_name+=(\"\$__line\")"
  done < <(parse_paths "$__key")
}

read_lines_into OPENCLAW_PATHS openclawPaths
read_lines_into LOCAL_MODS localModsPaths

EXCLUDE_ARGS=()
for lm in "${LOCAL_MODS[@]:-}"; do
  [ -z "$lm" ] && continue
  EXCLUDE_ARGS+=(":(exclude)$lm")
done

echo "=== Pin bump preview ==="
echo "From: $FROM_SHA"
echo "To:   $NEW_SHA ($NEW_SHORT)"
echo "Upstream commit:"
git log -1 --format='  %h  %s%n  Author: %an <%ae>%n  Date:   %ai' "$NEW_SHA"
echo
echo "=== Diff summary (openclawPaths, excluding localMods) ==="
DIFF_STAT="$(git diff --stat "$FROM_SHA" "$NEW_SHA" -- "${OPENCLAW_PATHS[@]}" "${EXCLUDE_ARGS[@]}" || true)"
if [ -z "$DIFF_STAT" ]; then
  echo "(no changes in enforced paths)"
else
  printf '%s\n' "$DIFF_STAT"
fi
echo

read -r -p "Proceed with bump? [y/N] " REPLY
case "$REPLY" in
  y|Y|yes|YES) ;;
  *) echo "Aborted."; exit 0 ;;
esac

# Update pin file.
printf '%s\n' "$NEW_SHA" > "$PIN_FILE"

# Append SYNC_LOG entry.
TODAY="$(date -u +%Y-%m-%d)"
REVIEWER="$(git config user.name 2>/dev/null || echo unknown)"
{
  printf '\n## %s — bump\n\n' "$TODAY"
  printf -- '- **From:** `%s`\n' "$FROM_SHA"
  printf -- '- **To:** `%s`\n' "$NEW_SHA"
  printf -- '- **Reviewer:** %s\n' "$REVIEWER"
  printf -- '- **Diff summary:**\n\n  ```\n'
  if [ -n "$DIFF_STAT" ]; then
    printf '%s\n' "$DIFF_STAT" | sed 's/^/  /'
  else
    printf '  (no changes in enforced paths)\n'
  fi
  printf '  ```\n'
  printf -- '- **Notes:** (added by hand if needed)\n'
} >> "$SYNC_LOG"

echo
echo "Pin bumped. Review the changes and commit with:"
echo "  git add -A && git commit -m \"security: bump openclaw pin to $NEW_SHORT\""
