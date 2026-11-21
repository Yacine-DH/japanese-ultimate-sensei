#!/usr/bin/env bash
# Start a headless Antigravity (agy) run from another agent or the owner.
#
#   scripts/antigravity.sh "Review PR #79 and post findings"      # foreground
#   scripts/antigravity.sh --review 79                              # PR review preset
#   scripts/antigravity.sh --issue 29                               # work an issue preset
#
# Runs in its OWN worktree (../sensei-antigravity-bot) so it never touches the owner's
# interactive Antigravity session in ../sensei-antigravity. One headless run at a time (lock).
# Output: ../agent-logs/antigravity-<timestamp>.log. Prints the final answer on stdout.
# Permissions stay on: reviews run read-only (plan mode) and the script posts the result;
# other tasks run in Antigravity's auto mode.
set -euo pipefail

REPO="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
PROJECTS="$(dirname "$(git -C "$REPO" rev-parse --path-format=absolute --git-common-dir)")"
PROJECTS="$(dirname "$PROJECTS")"
BOT="$PROJECTS/sensei-antigravity-bot"
LOGS="$PROJECTS/agent-logs"
CHANNEL="$PROJECTS/sensei-channel.md"
TIMEOUT="${AGY_TIMEOUT:-0}"  # 0 = until the turn completes
mkdir -p "$LOGS"

REVIEW_PR=""
MODE_FLAGS=(--mode auto)  # Antigravity's own permission checks stay on
case "${1:-}" in
  --review)
    REVIEW_PR="$2"
    MODE_FLAGS=(--mode plan)  # read-only: it writes the review, this script posts it
    TASK="Review pull request #$2 (read it with: gh pr view $2; gh pr diff $2). Check
correctness, the API contract (docs/API.md, docs/openapi.json) and that it works with
extension/ and web/. Do not modify anything. Output ONLY the review in Markdown: a one-line
verdict, then numbered findings (file:line, what is wrong, concrete failure scenario, fix),
or 'No issues found.' This text is posted on the PR as is." ;;
  --issue)
    TASK="Work on issue #$2 (gh issue view $2) end to end per AGENTS.md: comment 'Claimed by
Antigravity (headless)' on the issue, branch antigravity/<id>-<slug> from origin/master, tests,
lint, build, PR with 'Closes #$2', self-merge when green." ;;
  ""|-h|--help) sed -n '2,13p' "$0"; exit 0 ;;
  *) TASK="$*" ;;
esac
# The owner may override, e.g. AGY_FLAGS="--mode accept-edits"; never set by agents.
if [[ -n "${AGY_FLAGS:-}" ]]; then read -r -a MODE_FLAGS <<<"$AGY_FLAGS"; fi

if [[ ! -d "$BOT" ]]; then
  git -C "$REPO" fetch -q origin
  git -C "$REPO" worktree add -q --detach "$BOT" origin/master
fi
git -C "$BOT" fetch -q origin
if [[ -z "$(git -C "$BOT" status --porcelain)" ]]; then
  git -C "$BOT" checkout -q --detach origin/master
fi
for d in extension web; do
  [[ -d "$BOT/$d/node_modules" ]] || (cd "$BOT/$d" && pnpm install --frozen-lockfile >/dev/null 2>&1 || true)
done

REPORT=""
if [[ -z "$REVIEW_PR" ]]; then
  REPORT=" When done, append a short entry to the channel (append only; header
'## <UTC time> · Antigravity (headless) → Claude · <title>') and finish with a 3-5 line summary."
fi
PROMPT="You are Antigravity, the frontend agent (owns extension/ and web/) of the Japanese
Ultimate Sensei repo, started headless by Claude or the owner. Work ONLY in $BOT. Another,
interactive Antigravity session may be working in $PROJECTS/sensei-antigravity: never touch
that directory, and skip issues it has claimed (check the channel, assignees and TASKS.md).
Before starting, read AGENTS.md and the agent channel $CHANNEL.$REPORT

TASK:
$TASK"

LOG="$LOGS/antigravity-$(date +%Y%m%d-%H%M%S).log"
exec 9>"$LOGS/.antigravity.lock"
if ! flock -n 9; then
  echo "another headless Antigravity run is in progress (see $LOGS)" >&2
  exit 75
fi
echo "log: $LOG" >&2
cd "$BOT"
agy -p "$PROMPT" "${MODE_FLAGS[@]}" --print-timeout "${TIMEOUT}s" >"$LOG" 2>&1 || {
  echo "agy failed (exit $?), see $LOG" >&2; tail -20 "$LOG" >&2; exit 1; }
cat "$LOG"
if [[ -n "$REVIEW_PR" ]]; then
  BODY="$LOGS/review-$REVIEW_PR-$(date +%H%M%S).md"
  { echo "### Review by Antigravity (headless run)"; echo; cat "$LOG"; } >"$BODY"
  gh pr review "$REVIEW_PR" --comment --body-file "$BODY" \
    || gh pr comment "$REVIEW_PR" --body-file "$BODY"
  printf '\n## %s · Antigravity (headless) → Claude · Review of PR #%s posted\nSee the PR; log: %s\n' \
    "$(date -u '+%Y-%m-%d %H:%M UTC')" "$REVIEW_PR" "$LOG" >>"$CHANNEL"
fi
