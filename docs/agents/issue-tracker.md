<!--
Source: https://github.com/mattpocock/skills/blob/main/skills/engineering/setup-matt-pocock-skills/issue-tracker-github.md
License: ../../.github/skills/code-review/LICENSE
-->

# Issue Tracker: GitHub

Issues and specifications live in this repository's GitHub issues. Use `gh` in the clone so the repository is inferred from its remote; confirm the repository/account before writes. Create or modify external issues/comments only within the user's authorized task.

| Task                       | Command                                                             |
| -------------------------- | ------------------------------------------------------------------- |
| Read issue and discussion  | `gh issue view <number> --comments`                                 |
| Read structured issue data | `gh issue view <number> --json title,body,labels,comments`          |
| List open issues           | `gh issue list --state open --json number,title,labels`             |
| Read PR and diff           | `gh pr view <number> --comments` and `gh pr diff <number>`          |
| Create issue               | `gh issue create --title "..." --body-file <file>`                  |
| Comment                    | `gh issue comment <number> --body-file <file>`                      |
| Update labels              | `gh issue edit <number> --add-label "..."` / `--remove-label "..."` |

Write multiline bodies to a file to preserve their exact formatting. GitHub shares numbering between issues and PRs; resolve the object before choosing a command.

**PRs as a request surface: no.** External PRs are reviewed as proposed changes, not automatically converted into feature requests. No wayfinding labels, assignments, or issue-dependency workflow is required for ordinary repository work.
