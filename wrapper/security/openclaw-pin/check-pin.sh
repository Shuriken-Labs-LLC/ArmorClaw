#!/usr/bin/env bash
# OpenClaw upstream pin drift + signature check.
#
# Two layers run on every release build:
#   1. Tree-drift: local OpenClaw-owned files must match upstream@PIN
#      (modulo PATHS.json#localModsPaths). Override: ALLOW_OPENCLAW_DRIFT=1.
#   2. Tag signature: PINNED_SHA must be at a tag signed by a key listed
#      in UPSTREAM_KEYS.txt. Override: ALLOW_UNSIGNED_PIN=1.
#
# Exit codes:
#   0 - both checks passed (or applicable overrides set)
#   1 - drift detected outside localModsPaths, OR signature verification
#       failed, OR pinned SHA is not at a tagged commit
#   2 - environmental failure (missing pin / keys / config, fetch failure)
#
# Run from any directory; resolves paths relative to the repo root.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PIN_DIR="$REPO_ROOT/wrapper/security/openclaw-pin"
PIN_FILE="$PIN_DIR/PINNED_SHA.txt"
PATHS_FILE="$PIN_DIR/PATHS.json"
KEYS_FILE="$PIN_DIR/UPSTREAM_KEYS.txt"
UPSTREAM_URL="${OPENCLAW_UPSTREAM_URL:-https://github.com/openclaw/openclaw.git}"
UPSTREAM_REMOTE="openclaw-upstream"

cd "$REPO_ROOT"

# --- read pin ---
if [ ! -f "$PIN_FILE" ]; then
  echo "ERROR: pin file not found at $PIN_FILE" >&2
  exit 2
fi
PINNED_SHA="$(tr -d '[:space:]' < "$PIN_FILE")"
if [ -z "$PINNED_SHA" ]; then
  echo "ERROR: pin file is empty: $PIN_FILE" >&2
  exit 2
fi

# --- read PATHS.json ---
if [ ! -f "$PATHS_FILE" ]; then
  echo "ERROR: PATHS file not found at $PATHS_FILE" >&2
  exit 2
fi

# Validate PATHS.json once upfront so a parse error reports cleanly.
if ! node -e "
  try {
    const p = require('$PATHS_FILE');
    for (const k of ['armorclawPaths', 'openclawPaths', 'localModsPaths', 'ambiguousPathsToInvestigate']) {
      if (!Array.isArray(p[k])) {
        process.stderr.write('PATHS.json#' + k + ' is missing or not an array\n');
        process.exit(2);
      }
    }
  } catch (err) {
    process.stderr.write('Failed to parse PATHS.json: ' + err.message + '\n');
    process.exit(2);
  }
"; then
  exit 2
fi

# Parse with node (already required by the project; avoids jq dependency).
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
read_lines_into AMBIGUOUS ambiguousPathsToInvestigate

if [ "${#AMBIGUOUS[@]}" -gt 0 ]; then
  echo "ERROR: PATHS.json#ambiguousPathsToInvestigate is non-empty:" >&2
  printf '  - %s\n' "${AMBIGUOUS[@]}" >&2
  echo "Resolve each entry into armorclawPaths, openclawPaths, or localModsPaths before running drift check." >&2
  exit 2
fi

if [ "${#OPENCLAW_PATHS[@]}" -eq 0 ]; then
  echo "ERROR: PATHS.json#openclawPaths is empty - nothing to enforce" >&2
  exit 2
fi

# --- ensure upstream remote ---
if ! git remote get-url "$UPSTREAM_REMOTE" >/dev/null 2>&1; then
  git remote add "$UPSTREAM_REMOTE" "$UPSTREAM_URL"
fi

# --- fetch pinned SHA ---
if ! git cat-file -e "$PINNED_SHA^{commit}" 2>/dev/null; then
  if ! git fetch "$UPSTREAM_REMOTE" "$PINNED_SHA" --quiet 2>/dev/null; then
    # Fall back to fetching default branches so the SHA becomes reachable.
    git fetch "$UPSTREAM_REMOTE" --quiet 2>/dev/null || true
    if ! git cat-file -e "$PINNED_SHA^{commit}" 2>/dev/null; then
      echo "ERROR: cannot resolve pinned SHA $PINNED_SHA from $UPSTREAM_REMOTE ($UPSTREAM_URL)" >&2
      echo "Hint: check network, verify SHA, or set OPENCLAW_UPSTREAM_URL if upstream moved." >&2
      exit 2
    fi
  fi
fi

# --- compute drift, per openclawPath, with localMods exclusions ---
EXCLUDE_ARGS=()
for lm in "${LOCAL_MODS[@]:-}"; do
  [ -z "$lm" ] && continue
  EXCLUDE_ARGS+=(":(exclude)$lm")
done

# Compare pin against the working tree (no second ref). Release builds
# bundle files from the working tree, so any deviation - committed,
# staged, or unstaged - counts as drift.
DRIFTED=()
for p in "${OPENCLAW_PATHS[@]}"; do
  [ -z "$p" ] && continue
  if ! git diff --quiet "$PINNED_SHA" -- "$p" "${EXCLUDE_ARGS[@]}"; then
    DRIFTED+=("$p")
  fi
done

# --- drift report ---
if [ "${#DRIFTED[@]}" -gt 0 ]; then
  echo "OpenClaw pin DRIFT detected. Drifted paths:" >&2
  printf '  - %s\n' "${DRIFTED[@]}" >&2
  echo >&2
  echo "Run 'wrapper/security/openclaw-pin/bump-pin.sh <new-sha>' after reviewing upstream changes," >&2
  echo "or set ALLOW_OPENCLAW_DRIFT=1 to bypass for dev builds." >&2

  if [ "${ALLOW_OPENCLAW_DRIFT:-}" = "1" ]; then
    echo
    echo "ALLOW_OPENCLAW_DRIFT=1 set, continuing with drift (signature still enforced)."
  else
    exit 1
  fi
fi

# --- tag signature verification ---
# Verifies the pinned SHA is at a tag signed by a key in UPSTREAM_KEYS.txt.
# A clean working tree alone is not sufficient: an attacker who can rewrite
# upstream history (or who controls a malicious mirror) could publish a
# matching SHA without a corresponding signed tag. Signature verification
# closes that gap.
if [ ! -f "$KEYS_FILE" ]; then
  echo "ERROR: UPSTREAM_KEYS.txt missing at $KEYS_FILE — required for signature verification." >&2
  echo "Restore the file from git history; do not bypass this check." >&2
  exit 2
fi

TAG_AT_PIN="$(git tag --points-at "$PINNED_SHA" --sort=-creatordate 2>/dev/null | head -n 1 || true)"

if [ -z "$TAG_AT_PIN" ]; then
  if [ "${ALLOW_UNSIGNED_PIN:-}" = "1" ]; then
    echo "WARNING: pinned SHA $PINNED_SHA is not at a tagged commit." >&2
    echo "ALLOW_UNSIGNED_PIN=1 set, continuing. Add a Notes entry to SYNC_LOG.md explaining why." >&2
  else
    echo "ERROR: pinned SHA $PINNED_SHA is not at a tagged commit. Refusing." >&2
    echo "Either bump the pin to a tagged release, or set ALLOW_UNSIGNED_PIN=1 with a SYNC_LOG note." >&2
    exit 1
  fi
else
  VERIFY_OUTPUT="$(git -c gpg.ssh.allowedSignersFile="$KEYS_FILE" tag --verify "$TAG_AT_PIN" 2>&1)" \
    && VERIFY_EXIT=0 || VERIFY_EXIT=$?
  if [ "$VERIFY_EXIT" -ne 0 ]; then
    if [ "${ALLOW_UNSIGNED_PIN:-}" = "1" ]; then
      echo "WARNING: tag $TAG_AT_PIN signature verification failed." >&2
      printf '%s\n' "$VERIFY_OUTPUT" >&2
      echo "ALLOW_UNSIGNED_PIN=1 set, continuing. Add a Notes entry to SYNC_LOG.md explaining why." >&2
    else
      echo "ERROR: tag $TAG_AT_PIN signature verification failed:" >&2
      printf '%s\n' "$VERIFY_OUTPUT" >&2
      exit 1
    fi
  fi
fi

# --- success ---
if [ "${#DRIFTED[@]}" -eq 0 ]; then
  echo "OpenClaw pin OK: HEAD matches upstream@$PINNED_SHA across all enforced paths."
fi
if [ -n "$TAG_AT_PIN" ] && [ "${VERIFY_EXIT:-0}" -eq 0 ]; then
  echo "OpenClaw signature OK: tag $TAG_AT_PIN verified against UPSTREAM_KEYS.txt."
fi
exit 0
