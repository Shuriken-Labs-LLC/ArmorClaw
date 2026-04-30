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
KEYS_FILE="$PIN_DIR/UPSTREAM_KEYS.txt"
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

# --- tag signature verification ---
# Refuse to record a pin at an unsigned/untagged commit unless the human
# acknowledges the gap with ALLOW_UNSIGNED_PIN=1 + a Notes reason captured
# in the SYNC_LOG entry.
if [ ! -f "$KEYS_FILE" ]; then
  echo "ERROR: UPSTREAM_KEYS.txt missing at $KEYS_FILE — required for signature verification." >&2
  exit 2
fi

NEW_TAG="$(git tag --points-at "$NEW_SHA" --sort=-creatordate 2>/dev/null | head -n 1 || true)"
SIGNATURE_STATE="unverified"
SIGNATURE_REASON=""
UNSIGNED_NOTE_REQUIRED=0

if [ -z "$NEW_TAG" ]; then
  SIGNATURE_REASON="untagged commit"
  if [ "${ALLOW_UNSIGNED_PIN:-}" = "1" ]; then
    echo "WARNING: new SHA $NEW_SHA is not at a tagged commit. ALLOW_UNSIGNED_PIN=1 set, continuing." >&2
    UNSIGNED_NOTE_REQUIRED=1
  else
    echo "ERROR: new SHA $NEW_SHA is not at a tagged commit." >&2
    echo "Bump to a tagged release, or set ALLOW_UNSIGNED_PIN=1 (you'll be required to provide a Notes reason)." >&2
    exit 1
  fi
else
  VERIFY_OUTPUT="$(git -c gpg.ssh.allowedSignersFile="$KEYS_FILE" tag --verify "$NEW_TAG" 2>&1)" \
    && VERIFY_EXIT=0 || VERIFY_EXIT=$?
  if [ "$VERIFY_EXIT" -ne 0 ]; then
    SIGNATURE_REASON="signature failed verification"
    if [ "${ALLOW_UNSIGNED_PIN:-}" = "1" ]; then
      echo "WARNING: tag $NEW_TAG signature verification failed. ALLOW_UNSIGNED_PIN=1 set, continuing." >&2
      printf '%s\n' "$VERIFY_OUTPUT" >&2
      UNSIGNED_NOTE_REQUIRED=1
    else
      echo "ERROR: tag $NEW_TAG signature verification failed:" >&2
      printf '%s\n' "$VERIFY_OUTPUT" >&2
      exit 1
    fi
  else
    SIGNATURE_STATE="verified"
  fi
fi

# If override is in play, require a Notes reason now (before preview, so the
# reason is on the user's mind when they review the diff).
UNSIGNED_NOTE=""
if [ "$UNSIGNED_NOTE_REQUIRED" = "1" ]; then
  echo
  echo "ALLOW_UNSIGNED_PIN=1 is overriding signature verification."
  echo "Provide a Notes reason explaining why an unverified pin is acceptable here."
  echo "It will be recorded in SYNC_LOG.md as a permanent audit-trail entry."
  read -r -p "Notes: " UNSIGNED_NOTE
  if [ -z "$UNSIGNED_NOTE" ]; then
    echo "ERROR: Notes reason is required when ALLOW_UNSIGNED_PIN=1. Aborting." >&2
    exit 1
  fi
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
  if [ "$SIGNATURE_STATE" = "verified" ]; then
    printf -- '- **Signature:** Verified via tag `%s` against `UPSTREAM_KEYS.txt`.\n' "$NEW_TAG"
  else
    printf -- '- **Signature:** UNVERIFIED. Reason: %s. Override: `ALLOW_UNSIGNED_PIN=1`.\n' "$SIGNATURE_REASON"
  fi
  printf -- '- **Diff summary:**\n\n  ```\n'
  if [ -n "$DIFF_STAT" ]; then
    printf '%s\n' "$DIFF_STAT" | sed 's/^/  /'
  else
    printf '  (no changes in enforced paths)\n'
  fi
  printf '  ```\n'
  if [ -n "$UNSIGNED_NOTE" ]; then
    printf -- '- **Notes:** %s\n' "$UNSIGNED_NOTE"
  else
    printf -- '- **Notes:** (added by hand if needed)\n'
  fi
} >> "$SYNC_LOG"

echo
echo "Pin bumped. Review the changes and commit with:"
echo "  git add -A && git commit -m \"security: bump openclaw pin to $NEW_SHORT\""
