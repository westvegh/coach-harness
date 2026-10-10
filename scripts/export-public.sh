#!/usr/bin/env bash
# Copies the public tree (scripts/public-tree.txt) into an empty folder, with no git history.
#
#   scripts/export-public.sh <empty-or-new-dir>
#
# Only files tracked by git are copied, from the working tree. Untracked and ignored files
# (node_modules/, evals/results/, athlete/.cache/) never ship. The script refuses a dirty
# tree, so the export matches a commit; set ALLOW_DIRTY=1 to skip that check (tests).
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: scripts/export-public.sh <empty-or-new-dir>" >&2
  exit 2
fi
dest="$1"

root="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
list="$root/scripts/public-tree.txt"
[ -f "$list" ] || { echo "export-public: missing $list" >&2; exit 1; }

if [ -e "$dest" ] && [ -n "$(ls -A "$dest" 2>/dev/null)" ]; then
  echo "export-public: $dest is not empty" >&2
  exit 1
fi

if [ "${ALLOW_DIRTY:-0}" != "1" ] && [ -n "$(git -C "$root" status --porcelain --untracked-files=no)" ]; then
  echo "export-public: the working tree has uncommitted changes; commit them first (or set ALLOW_DIRTY=1)" >&2
  exit 1
fi

includes=()
excludes=()
while IFS= read -r line || [ -n "$line" ]; do
  line="${line%%$'\r'}"
  case "$line" in
    ""|"#"*) continue ;;
    "!"*) excludes+=("${line#!}") ;;
    *) includes+=("$line") ;;
  esac
done < "$list"

# matches <path> <pattern>: a folder pattern ("x/") matches by prefix, a file pattern exactly.
matches() {
  case "$2" in
    */) [[ "$1" == "$2"* ]] ;;
    *) [[ "$1" == "$2" ]] ;;
  esac
}

is_athlete_path() {
  [[ "$1" == templates/athlete/* ]] && return 1
  [[ "/$1/" == */athlete/* ]]
}

mkdir -p "$dest"
count=0
while IFS= read -r -d '' path; do
  keep=0
  for p in ${includes[@]+"${includes[@]}"}; do matches "$path" "$p" && { keep=1; break; }; done
  [ "$keep" = 1 ] || continue
  for p in ${excludes[@]+"${excludes[@]}"}; do matches "$path" "$p" && { keep=0; break; }; done
  [ "$keep" = 1 ] || continue
  is_athlete_path "$path" && continue
  # A tracked file deleted from the working tree is skipped (ALLOW_DIRTY only).
  [ -e "$root/$path" ] || continue
  mkdir -p "$dest/$(dirname "$path")"
  cp -p "$root/$path" "$dest/$path"
  count=$((count + 1))
done < <(git -C "$root" ls-files -z)

echo "export-public: copied $count files to $dest (from $(git -C "$root" rev-parse --short HEAD))" >&2
# The manifest: every exported file with its git mode and blob id (contracts §24).
node "$root/scripts/template-manifest.ts" "$dest"
