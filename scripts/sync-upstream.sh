#!/usr/bin/env bash
# Bring this Linux fork up to date with the repo it was forked from.
#
# The fork's value is that it tracks upstream: every release rakanki911 ships
# should land here, with the Linux work sitting on top of it. Doing that by hand
# is where it goes wrong - a fetch on a dirty tree, a rebase that eats a day of
# work. This refuses to touch anything it cannot do safely.
#
#   scripts/sync-upstream.sh            report what is new, change nothing
#   scripts/sync-upstream.sh --pull     rebase this branch onto upstream, then test
#
set -euo pipefail

REPO_URL="https://github.com/rakanki911/DLSS5-Swapper.git"
BRANCH="main"

cd "$(dirname "$0")/.."

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "Not a git checkout." >&2
  exit 1
fi

git remote get-url upstream >/dev/null 2>&1 \
  || git remote add upstream "$REPO_URL"

echo "Fetching upstream ($BRANCH) ..."
git fetch --quiet upstream "$BRANCH"
UPSTREAM_REV="$(git rev-parse --short "upstream/$BRANCH")"

HERE="$(git rev-parse --abbrev-ref HEAD)"
BEHIND="$(git rev-list --count "HEAD..upstream/$BRANCH")"
AHEAD="$(git rev-list --count "upstream/$BRANCH..HEAD")"

echo "  branch        : $HERE"
echo "  upstream/$BRANCH : $UPSTREAM_REV"
echo "  this branch   : $AHEAD commit(s) of our own, $BEHIND behind upstream"

if [ "$BEHIND" -eq 0 ]; then
  echo
  echo "Already current with upstream. Nothing to pull."
  exit 0
fi

echo
echo "New upstream commits:"
git --no-pager log --oneline "HEAD..upstream/$BRANCH" | sed 's/^/  /'

if [ "${1:-}" != "--pull" ]; then
  echo
  echo "Report only. Re-run with --pull to rebase this branch onto upstream and test."
  exit 0
fi

if [ -n "$(git status --porcelain)" ]; then
  echo
  echo "Refusing to pull with uncommitted changes - commit or stash them first:" >&2
  git status --short >&2
  exit 1
fi

echo
echo "Rebasing $HERE onto upstream/$BRANCH ..."
git rebase "upstream/$BRANCH"

echo
echo "Running the test suite ..."
npm test

echo
echo "Done. $HERE is now on upstream $UPSTREAM_REV with our commits on top."
echo "Push when you are happy:  git push origin $HERE"
