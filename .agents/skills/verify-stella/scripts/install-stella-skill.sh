#!/usr/bin/env bash
set -euo pipefail

skill_dir="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd -P "$skill_dir/../../.." && pwd)"
target="${STELLA_SKILLS_DIR:-$HOME/.stella/skills}/verify-stella"

if [[ -L "$target" ]]; then
  rm -f -- "$target"
fi
mkdir -p "$target"

for existing in "$target"/* "$target"/.[!.]*; do
  [[ -e "$existing" || -L "$existing" ]] || continue
  if [[ -L "$existing" ]]; then
    case "$(readlink "$existing")" in
      "$skill_dir"/*) rm -f -- "$existing" ;;
    esac
  else
    printf 'Leaving unexpected non-link entry: %s\n' "$existing" >&2
  fi
done

while IFS= read -r entry; do
  [[ -n "$entry" && "$entry" != .gitignore ]] || continue
  ln -s "$skill_dir/$entry" "$target/$entry"
done < <(git -C "$repo_root" ls-files -co --exclude-standard -- "$skill_dir" | sed "s#^.agents/skills/verify-stella/##" | cut -d/ -f1 | sort -u)

printf 'installed=%s\nsource=%s\n' "$target" "$skill_dir"
