#!/usr/bin/env bash
set -eu

if [[ $1 != pull_request ]]; then
  echo 'docs_only=false'
  exit 0
fi

range="$2...$3"
# Disable rename detection so both the old and new paths are classified.
if git diff --quiet --no-renames "$range" -- ':(exclude)*.md' ':(glob,exclude)docs/**'; then
  if git diff --quiet "$range" --; then
    echo 'docs_only=false'
  else
    status=$?
    [[ $status == 1 ]] || exit "$status"
    echo 'docs_only=true'
  fi
else
  status=$?
  [[ $status == 1 ]] || exit "$status"
  echo 'docs_only=false'
fi
