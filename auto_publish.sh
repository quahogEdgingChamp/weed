#!/usr/bin/env bash
# Publish the saved guides to the public GitHub Pages copy, unattended.
#
# Run by ~/.config/systemd/user/weed-publish.service, which is started by
# weed-publish.path (a guide was saved/changed/deleted) and weed-publish.timer
# (a safety net every 30 min). Safe to run by hand at any time.
#
# It only ever commits published/: anything else you have staged or edited is
# left alone. It does nothing unless the repo is on main with no merge/rebase
# in progress, and nothing at all if the published files didn't change.
set -euo pipefail

REPO=/home/qwerty/git/weed
cd "$REPO"

# One run at a time: a burst of saves queues up behind this lock.
exec 9>"$REPO/.git/weed-publish.lock"
flock 9

# Let a run that is still rewriting reports (store prices, how-to-start) settle.
sleep "${PUBLISH_SETTLE_SECONDS:-30}"

branch=$(git symbolic-ref --quiet --short HEAD || echo detached)
if [[ "$branch" != main ]]; then
    echo "skip: repo is on '$branch', not main"
    exit 0
fi
for marker in MERGE_HEAD rebase-merge rebase-apply CHERRY_PICK_HEAD; do
    if [[ -e .git/$marker ]]; then
        echo "skip: a git $marker is in progress"
        exit 0
    fi
done

python3 publish_research.py
git add -A -- published
if git diff --cached --quiet -- published; then
    echo "nothing new to publish"
    exit 0
fi

count=$(ls published/research/reports | wc -l)
# A pathspec makes git commit only published/, whatever else is staged.
git commit --quiet -m "Research: publish the latest guides ($count)" -- published

export GIT_TERMINAL_PROMPT=0   # never hang waiting for a password
status=0
git push --quiet github main || { echo "push to github failed"; status=1; }
git push --quiet origin main || { echo "push to forgejo failed"; status=1; }
[[ $status == 0 ]] && echo "published $count guides; GitHub Pages rebuilds in ~1 min"
exit $status
