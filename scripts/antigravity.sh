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
set -euo pipefail

REPO="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
PROJECTS="$(dirname "$(git -C "$REPO" rev-parse --path-format=absolute --git-common-dir)")"
PROJECTS="$(dirname "$PROJECTS")"
BOT="$PROJECTS/sensei-antigravity-bot"
LOGS="$PROJECTS/agent-logs"
CHANNEL="$PROJECTS/sensei-channel.md"
TIMEOUT="${AGY_TIMEOUT:-0}"  # 0 = until the turn completes
mkdir -p "$LOGS"

case "${1:-}" in
  --review)
    TASK="Review pull request #$2 (gh pr view $2; gh pr diff $2). Check correctness, the API
contract (docs/API.md, docs/openapi.json) and that it works with extension/ and web/. Post the
review with: gh pr review $2 --comment --body '...' (both agents share one GitHub account, so
approve/request-changes is not possible). For each real bug, open an issue labelled
review-finding + the owning agent:* label. Do NOT edit server/ and do not push to that PR." ;;
  --issue)
    TASK="Work on issue #$2 (gh issue view $2) end to end per AGENTS.md: comment 'Claimed by
Antigravity (headless)' on the issue, branch antigravity/<id>-<slug> from origin/master, tests,
lint, build, PR with 'Closes #$2', self-merge when green." ;;
  ""|-h|--help) sed -n '2,12p' "$0"; exit 0 ;;
  *) TASK="$*" ;;
esac

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

PROMPT="You are Antigravity, the frontend agent (owns extension/ and web/) of the Japanese
Ultimate Sensei repo, started headless by Claude or the owner. Work ONLY in $BOT. Another,
interactive Antigravity session may be working in $PROJECTS/sensei-antigravity: never touch
that directory, and skip issues it has claimed (check the channel, assignees and TASKS.md).
Before starting, read AGENTS.md and the agent channel $CHANNEL. When done, append a short
entry to the channel (append only; header '## <UTC time> · Antigravity (headless) → Claude ·
<title>') and finish with a 3-5 line summary.

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
agy -p "$PROMPT" --dangerously-skip-permissions --print-timeout "${TIMEOUT}s" 2>&1 | tee "$LOG"
