#!/usr/bin/env bash
# Toolkit wrapper for bundled Claude HUD and prompt-cache status.
input=$(cat)
cols=$( (stty size </dev/tty) 2>/dev/null | awk '{print $2}')
export COLUMNS=$(( ${cols:-120} > 4 ? ${cols:-120} - 4 : 1 ))
node_bin=${TOOLKIT_NODE:-node}
jq_bin=${TOOLKIT_JQ:-jq}
bundle_dir=${TOOLKIT_STATUSLINE_DIR:-$(cd "$(dirname "$0")" && pwd)}
printf '%s' "$input" | "$node_bin" "$bundle_dir/claude-hud/dist/index.js"
cache_line=$(printf '%s' "$input" | "$jq_bin" -r '
  (.context_window.current_usage // null) as $cu
  | (if $cu == null then null else (($cu.cache_read_input_tokens // 0) as $cr | ($cr + ($cu.cache_creation_input_tokens // 0) + ($cu.input_tokens // 0)) as $tot | if $tot > 0 then ($cr / $tot) else null end) end) as $cuhr
  | if .prompt_cache == null and $cuhr == null then empty else
    (if .prompt_cache == null or .prompt_cache.caching_observed != true then "none" elif .prompt_cache.warm == true then "warm" else "cold" end) as $state
    | (if $state == "none" then "-" else ((.prompt_cache.misses // 0) | tostring) end) as $misses
    | (if $state == "none" then $cuhr else (.prompt_cache.hit_ratio // $cuhr) end) as $hr
    | (if $hr == null then "-" else ((($hr * 100) | floor | tostring) + "%") end) as $hrstr
    | (.prompt_cache.last_miss_cause.causes[0] // "") as $cause
    | ($state + "\t" + $misses + "\t" + $hrstr + "\t" + $cause)
  end
' 2>/dev/null)
if [ -n "$cache_line" ]; then
  IFS=$'\t' read -r state misses hitratio cause <<< "$cache_line"
  DIM=$'\033[2m'; YELLOW=$'\033[2;33m'; GREEN=$'\033[2;32m'; RESET=$'\033[0m'
  if [ "$state" = "none" ]; then printf "%sCache:%s hit:%s\n" "$DIM" "$RESET" "$hitratio"
  elif [ "$state" = "warm" ]; then printf "%sCache:%s %swarm%s | miss:%s hit:%s\n" "$DIM" "$RESET" "$GREEN" "$RESET" "$misses" "$hitratio"
  else
    cause_suffix=""; [ -n "$cause" ] && cause_suffix=" (${cause})"
    printf "%sCache:%s %sdropped%s%s | miss:%s hit:%s\n" "$DIM" "$RESET" "$YELLOW" "$RESET" "$cause_suffix" "$misses" "$hitratio"
  fi
fi
