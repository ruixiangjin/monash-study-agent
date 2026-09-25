#!/bin/zsh

set -u

project_root="${0:A:h}"

fail() {
  print -u2 ""
  print -u2 "Monash Study Agent could not start: $1"
  print -u2 "Install or restore development dependencies manually, then run this launcher again."
  read -r "?Press Return to close this window..."
  exit 1
}

cd -- "$project_root" || fail "could not open the project directory."

command -v node >/dev/null 2>&1 || fail "Node.js is not available on PATH."
command -v pnpm >/dev/null 2>&1 || fail "pnpm is not available on PATH."
[[ -d node_modules ]] || fail "node_modules is missing."
[[ -e node_modules/tsx ]] || fail "the local development dependencies are incomplete (tsx is missing)."

print "Starting Monash Study Agent from $project_root"
pnpm ui
status=$?

if (( status != 0 )); then
  print -u2 ""
  print -u2 "Monash Study Agent stopped with exit code $status."
  read -r "?Press Return to close this window..."
fi

exit "$status"
