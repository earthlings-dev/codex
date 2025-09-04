# LOCALAGENTS: repo + release notes

Purpose: quick reference for how this fork (earth-sol/codex) stays in sync with upstream (openai/codex), which tags to use for Rust builds, and how to build codex-rs locally.

## Remotes
- origin: git@github.com:earth-sol/codex.git (this fork)
- upstream: git@github.com:openai/codex.git (source)

Add upstream (already set):
- git remote add upstream git@github.com:openai/codex.git
- git fetch upstream --tags --prune

## Current state
- Local main is up to date with origin/main.
- Upstream Rust tags present locally: rust-v0.28.0, rust-v0.29.0 (and pre-releases like rust-v0.29.1-alpha.1).
- Update banner in the TUI checks GitHub latest release tag for openai/codex and expects a rust-v... tag. Seeing 0.29.0 corresponds to a Rust release tag, not the JS CLI.

## Sync strategy (automated)
A GitHub Action mirrors upstream branches/tags into this fork, overwriting conflicts in this repo:
- File: .github/workflows/sync-upstream.yml
- Triggers: hourly (cron) and manual (workflow_dispatch)
- Direction: fetch from upstream (openai/codex) → force-push to origin (earth-sol/codex)
- Scope:
  - Branches: all upstream branch names are force-pushed to the same names on this fork.
  - Tags: all upstream tags are force-pushed to this fork.
  - Extras in this fork (branches/tags that don’t exist upstream) are kept; nothing is deleted.
- Caveat: force-pushing protected branches (e.g., main) may fail if branch protection disallows it. Either allow force-pushes or update the workflow to skip protected branches.

Manual run (GitHub UI): Actions → "Sync upstream branches and tags" → Run workflow.

## Optional variations
- Skip protected branches: adjust the workflow to continue when branch is protected or exclude specific names (e.g., main).
- Full mirror (prune extras): add steps that delete branches/tags on this fork that don’t exist upstream. Not enabled by default.
- Use SSH in CI: swap upstream URL to git@github.com:openai/codex.git and provide a deploy key/secret. HTTPS with GITHUB_TOKEN is currently used.

## Manual sync commands (local)
- Update this fork from origin:
  - git fetch --prune origin
  - git switch main
  - git merge --ff-only origin/main
- Refresh upstream tags/branches locally:
  - git fetch upstream --tags --prune
  - git fetch upstream --prune

## Building codex-rs (Rust)
- From a release tag (example: 0.29.0):
  - git fetch upstream --tags
  - git checkout rust-v0.29.0
  - cargo build -p codex-tui --release
- From latest main:
  - git switch main
  - cargo build -p codex-tui --release

Notes:
- codex-rs is a Rust workspace; individual crates are prefixed with codex- (e.g., codex-core, codex-tui).
- The TUI’s update check is implemented in codex-rs/tui/src/updates.rs and reads openai/codex latest release tag (expects rust-v...).

## Quick troubleshooting
- Tags not showing: git fetch upstream --tags --force
- Force overwrite a branch in this fork with upstream: git push origin --force refs/remotes/upstream/BRANCH:refs/heads/BRANCH
- Force push tags to this fork: git push origin --force --tags

