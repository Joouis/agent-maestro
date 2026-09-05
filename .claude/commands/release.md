---
name: release
description: Update main, version pending changesets, review release files, and prepare a release PR
---

# Release Process

Follow [AGENTS.md](../../AGENTS.md#commits-changesets-and-releases). Begin only when a release is requested, and verify a clean worktree so unrelated changes cannot enter the release.

## Prepare

```bash
git status --short
git switch main
git pull --ff-only origin main
pnpm changeset:version
```

Read the resulting version from `package.json`, then create `release/v{VERSION}` using that exact version. The version command updates package metadata/changelog and consumes pending changesets; do not edit version fields independently.

## Review

- Inspect every changed file and verify the version and release notes.
- Keep notes focused on user-visible behavior; preserve older changelog history.
- Run checks appropriate to any release edits.
- Discuss the concrete changelog with the user before committing unless that review step was explicitly waived.

## Commit and Publish the Branch

Stage only the reviewed release files, including consumed changeset deletions. Inspect `git diff --cached` before committing with `chore: release v{VERSION}`. Use actual contributor attribution only; do not add a fixed agent identity.

Push the release branch only with the user's authorization. Create a PR against `main` with the release summary and validation. Branch publication and PR creation do not authorize Marketplace/Open VSX publication.
