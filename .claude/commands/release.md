---
name: release
description: Create a release branch, run changeset version, review changelog, and prepare PR
---

# Release Process

Create a new release for the project following these steps:

## 1. Checkout and update main

```bash
git checkout main && git fetch origin && git pull origin main
```

## 2. Run changeset version

```bash
pnpm run changeset:version
```

## 3. Read new version and create release branch

- Read `package.json` to get the new version number
- Create release branch:

```bash
git checkout -b release/v{VERSION}
```

## 4. Review changes

- Check `git status` to see modified files
- Review `CHANGELOG.md` for accurate and clear entries
- Verify version bump in `package.json`
- **Discuss changelog with user before proceeding**

## 5. Improve changelog if needed

- Ensure entries describe user impact, not just technical changes
- Add context like "fixing issues with X" where relevant
- Keep entries concise but informative

## 6. Commit and push

```bash
git add -A && git commit -m "chore: release v{VERSION}

Co-Authored-By: Claude <noreply@anthropic.com>"
git push -u origin release/v{VERSION}
```

## 7. Create PR

Provide the user with the PR creation URL or create it via `gh pr create`.

---

**Important:** Always pause after step 4 to discuss the changelog with the user before committing.
