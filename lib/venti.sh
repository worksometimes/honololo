#!/usr/bin/env bash
# Venti — small, provider-neutral browser/evidence helpers.
#
# The skill owns planning and judgment. This file owns repeatable session plumbing,
# condition-based waits, and evidence capture. It intentionally has no site-specific
# selectors or business logic.

set -uo pipefail

venti_session_from() {
  local raw="${1:-default}"
  local host
  host=$(printf '%s' "$raw" | sed -E 's#^[a-zA-Z]+://##; s#/.*$##; s#:.*$##')
  [ -z "$host" ] && host="$raw"
  printf 'venti-%s' "$(printf '%s' "$host" | tr '.' '-' | tr -cd 'A-Za-z0-9-')"
}

VENTI_SESSION="${VENTI_SESSION:-$(venti_session_from "${1:-default}")}"
VENTI_ALLOWED_DOMAINS="${VENTI_ALLOWED_DOMAINS:-}"
export VENTI_SESSION
export VENTI_ALLOWED_DOMAINS

venti_require() {
  local command_name
  for command_name in "$@"; do
    command -v "$command_name" >/dev/null 2>&1 || {
      printf 'venti: missing prerequisite: %s\n' "$command_name" >&2
      return 1
    }
  done
}

# Every browser call restores the user-owned session. Do not pass secrets in CLI arguments.
ab() {
  if [ -n "$VENTI_ALLOWED_DOMAINS" ]; then
    # agent-browser intentionally rejects --restore together with --allowed-domains. An
    # allowlisted run starts a clean, bounded daemon; an unrestricted session may restore.
    agent-browser --session "$VENTI_SESSION" \
      --allowed-domains "$VENTI_ALLOWED_DOMAINS" "$@"
  else
    agent-browser --session "$VENTI_SESSION" --restore --restore-save auto "$@"
  fi
}

page_text() {
  ab get text body 2>/dev/null
}

page_url() {
  ab get url 2>/dev/null
}

page_has() {
  page_text | grep -qF -- "$1"
}

page_has_regex() {
  page_text | grep -qE -- "$1"
}

# Condition-based wait. The polling interval is an implementation detail; callers wait for a
# semantic condition rather than sleeping for a guessed page duration.
venti_wait_for_text() {
  local needle="$1" limit="${2:-30}" interval="${3:-1}" elapsed=0
  while [ "$elapsed" -lt "$limit" ]; do
    page_has "$needle" && return 0
    sleep "$interval"
    elapsed=$((elapsed + 1))
  done
  return 1
}

venti_wait_for_url() {
  local pattern="$1" limit="${2:-30}" elapsed=0
  while [ "$elapsed" -lt "$limit" ]; do
    page_url | grep -qE -- "$pattern" && return 0
    sleep 1
    elapsed=$((elapsed + 1))
  done
  return 1
}

# Login is always user-mediated. The helper only waits for the target host to reappear.
venti_wait_login() {
  local host="$1" limit="${2:-600}" elapsed=0
  while [ "$elapsed" -lt "$limit" ]; do
    page_url | grep -qF -- "$host" && return 0
    sleep 3
    elapsed=$((elapsed + 3))
  done
  return 1
}

# Wait until visible page text stops changing. Use only when the target has no better completion
# signal; pair it with a bounded limit and a final semantic assertion.
venti_wait_settled() {
  local quiet="${1:-2}" limit="${2:-120}" elapsed=0 previous="" current="" stable=0
  while [ "$elapsed" -lt "$limit" ]; do
    current=$(page_text | wc -c | tr -d ' ')
    if [ "$current" = "$previous" ]; then
      stable=$((stable + 1))
      [ "$stable" -ge "$quiet" ] && return 0
    else
      stable=0
    fi
    previous="$current"
    sleep 1
    elapsed=$((elapsed + 1))
  done
  return 1
}

venti_hash_file() {
  local file="$1"
  if command -v shasum >/dev/null 2>&1; then
    printf 'sha256:%s\n' "$(shasum -a 256 "$file" | awk '{print $1}')"
  elif command -v sha256sum >/dev/null 2>&1; then
    printf 'sha256:%s\n' "$(sha256sum "$file" | awk '{print $1}')"
  else
    printf 'venti: shasum or sha256sum is required to freeze a plan\n' >&2
    return 1
  fi
}

venti_run_dir() {
  local run_id="$1"
  printf '%s/runs/%s' "${VENTI_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}" "$run_id"
}

venti_init_run() {
  local run_id="$1" plan_id="$2" plan_hash="$3" target_url="$4"
  local run_dir
  venti_require jq || return 1
  run_dir=$(venti_run_dir "$run_id")
  mkdir -p "$run_dir" "$run_dir/evidence" "$run_dir/agents"
  [ -e "$run_dir/events.jsonl" ] || : > "$run_dir/events.jsonl"
  [ -e "$run_dir/results.jsonl" ] || : > "$run_dir/results.jsonl"
  [ -e "$run_dir/audit.jsonl" ] || : > "$run_dir/audit.jsonl"
  jq -n --arg run_id "$run_id" --arg plan_id "$plan_id" --arg plan_hash "$plan_hash" \
    --arg target_url "$target_url" --arg session "$VENTI_SESSION" \
    '{run_id:$run_id,plan_id:$plan_id,plan_hash:$plan_hash,target:{url:$target_url},session:$session,execution_mode:"inline_degraded",started_at:(now|todateiso8601)}' \
    > "$run_dir/manifest.json"
  printf '%s\n' "$run_dir"
}

venti_emit_event() {
  local run_dir="$1" node="$2" event_status="$3" item_id="${4:-}" attempt="${5:-0}"
  local ts
  venti_require jq || return 1
  ts=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
  jq -nc --arg ts "$ts" --arg node "$node" --arg status "$event_status" --arg item_id "$item_id" \
    --argjson attempt "$attempt" '{ts:$ts,node:$node,status:$status,item_id:$item_id,attempt:$attempt}' \
    >> "$run_dir/events.jsonl"
}

venti_checkpoint() {
  local run_dir="$1" node="$2" checkpoint_status="$3" item_id="${4:-}" attempt="${5:-0}"
  local plan_id="${6:-}" plan_hash="${7:-}" state_tmp
  venti_require jq || return 1
  state_tmp="$run_dir/state.json.tmp"
  jq -n --arg node "$node" --arg status "$checkpoint_status" --arg item_id "$item_id" \
    --arg plan_id "$plan_id" --arg plan_hash "$plan_hash" --argjson attempt "$attempt" \
    '{node:$node,status:$status,item_id:$item_id,attempt:$attempt,plan_id:$plan_id,plan_hash:$plan_hash,updated_at:(now|todateiso8601)}' \
    > "$state_tmp"
  mv "$state_tmp" "$run_dir/state.json"
  venti_emit_event "$run_dir" "$node" "$checkpoint_status" "$item_id" "$attempt"
}

venti_append_result() {
  local run_dir="$1" result_json="$2"
  venti_require jq || return 1
  printf '%s\n' "$result_json" | jq -c . >> "$run_dir/results.jsonl"
}

venti_capture_evidence() {
  local run_dir="$1" item_id="$2" attempt="${3:-1}" evidence_dir
  evidence_dir="$run_dir/evidence/$item_id/attempt-$attempt"
  mkdir -p "$evidence_dir"
  page_url > "$evidence_dir/url.txt" || true
  page_text > "$evidence_dir/page.txt" || true
  ab screenshot "$evidence_dir/screenshot.png" >/dev/null 2>&1 || true
  printf '%s\n' "$evidence_dir"
}
