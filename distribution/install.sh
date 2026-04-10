#!/bin/sh
# ArmorClaw installer — one command to get started.
#
# Usage:
#   curl -fsSL https://armorclaw.ai/install | sh
#
# What this does:
#   1. Checks that Node.js 22+ is installed
#   2. Installs ArmorClaw globally via npm
#   3. Launches the setup wizard
#
# Works on macOS, Linux, and Windows (Git Bash / WSL).
# No sudo required unless your npm global directory needs it.

set -e

# ── Colours (disabled in non-interactive shells) ──────────────────────────────

if [ -t 1 ]; then
  BOLD="\033[1m"
  GREEN="\033[32m"
  RED="\033[31m"
  RESET="\033[0m"
else
  BOLD=""
  GREEN=""
  RED=""
  RESET=""
fi

info()  { printf "%b%b%b\n" "$GREEN" "$1" "$RESET"; }
error() { printf "%b%b%b\n" "$RED"   "$1" "$RESET" >&2; }
bold()  { printf "%b%b%b\n" "$BOLD"  "$1" "$RESET"; }

# ── Node.js version check ────────────────────────────────────────────────────

if ! command -v node >/dev/null 2>&1; then
  error "Node.js is not installed."
  echo ""
  echo "ArmorClaw requires Node.js 22 or later."
  echo "Install it from: https://nodejs.org"
  echo ""
  exit 1
fi

NODE_MAJOR=$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))")

if [ "$NODE_MAJOR" -lt 22 ] 2>/dev/null; then
  error "Node.js 22 or later is required. You have v$(node -v | tr -d 'v')."
  echo ""
  echo "Update Node.js at: https://nodejs.org"
  echo "If you use nvm:  nvm install 22 && nvm use 22"
  echo ""
  exit 1
fi

info "Node.js v$(node -v | tr -d 'v') — ok"

# ── Install ArmorClaw ─────────────────────────────────────────────────────────

bold ""
bold "Installing ArmorClaw..."
echo ""

npm install -g armorclaw@latest

info ""
info "ArmorClaw installed."
echo ""

# ── Launch setup wizard ───────────────────────────────────────────────────────

bold "Launching the setup wizard..."
echo ""

armorclaw install
