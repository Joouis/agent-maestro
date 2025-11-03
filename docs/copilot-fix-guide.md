# GitHub Copilot Chat Auto-Fix Feature

## Overview

The `Agent Maestro: Fix GitHub Copilot Chat - Model is not supported error` command automatically removes the `x-onbehalf-extension-id` header from the GitHub Copilot Chat extension to enable support for additional AI models.

## How to Use

1. Open VS Code Command Palette (`Cmd+Shift+P` on macOS, `Ctrl+Shift+P` on Windows/Linux)
2. Search for and select: `Agent Maestro: Fix GitHub Copilot Chat - Model is not supported error`
3. Review the warning message and click "Yes, Proceed"
4. Wait for the process to complete (progress is shown in a notification)
5. When prompted, click "Reload Now" to restart VS Code

## What It Does

### Automatic Process Flow

1. **Locates Extension**: Finds your installed GitHub Copilot Chat extension automatically
2. **Creates Backup**: Generates a timestamped backup file (e.g., `extension.js.backup-2025-11-03T12-30-00-000Z`)
3. **Applies Fix**: Removes the `x-onbehalf-extension-id` header from the minified JavaScript
4. **Verifies Changes**: Confirms the modification was successful
5. **Prompts Reload**: Asks you to reload VS Code for changes to take effect

### Technical Details

The command modifies the GitHub Copilot Chat extension's `dist/extension.js` file by:

**Before:**

```javascript
S==="getExtraHeaders"?function(){return{...f.getExtraHeaders?.()??{},"x-onbehalf-extension-id":`${A}/${c}`}}:...
```

**After:**

```javascript
S==="getExtraHeaders"?function(){return{...f.getExtraHeaders?.()??{}}}:...
```

## Safety Features

- ✅ **Automatic Backup**: Always creates a backup before making changes
- ✅ **Verification**: Confirms the fix was applied correctly
- ✅ **Error Handling**: Comprehensive error messages for all failure scenarios
- ✅ **Reversible**: Backup allows manual restoration if needed

## Backup Location

Backups are saved in the same directory as the extension:

```
~/.vscode/extensions/github.copilot-chat-<version>/dist/extension.js.backup-<timestamp>
```

## Troubleshooting

### Extension Not Found

- **Issue**: "GitHub Copilot Chat extension not found"
- **Solution**: Ensure GitHub Copilot Chat extension is installed

### Pattern Not Found

- **Issue**: "Header pattern not found"
- **Solution**: The extension may have already been fixed or uses a different version

### Permission Denied

- **Issue**: File write errors
- **Solution**: Check file permissions on the extension directory

### Extension Updates

- **Issue**: Fix is overwritten after extension updates
- **Solution**: Simply run the command again after any Copilot Chat extension updates

## Manual Restoration

If you need to restore the original extension file:

1. Navigate to: `~/.vscode/extensions/github.copilot-chat-<version>/dist/`
2. Find the backup file: `extension.js.backup-<timestamp>`
3. Copy it back to `extension.js`:
   ```bash
   cd ~/.vscode/extensions/github.copilot-chat-<version>/dist/
   cp extension.js.backup-<timestamp> extension.js
   ```
4. Reload VS Code

## Logging

The command logs all operations to the Agent Maestro output channel:

1. Open Output panel: `View > Output`
2. Select "Agent Maestro" from the dropdown
3. Review detailed logs of the fix process

## Compatibility

- **macOS**: ✅ Tested and supported
- **Windows**: ✅ Supported (uses `%USERPROFILE%\.vscode\extensions\`)
- **Linux**: ✅ Supported (uses `~/.vscode/extensions/`)

## Security Note

This feature modifies installed extension files, which is generally safe but note that:

- Changes may be overwritten during extension updates
- GitHub has confirmed removing this header is safe
- A backup is always created before modifications
- The modification only affects local extension files

## Related Commands

- `Agent Maestro: Configure Claude Code Settings` - Setup Claude Code integration
- `Agent Maestro: Configure Codex Settings` - Setup Codex integration
- `Agent Maestro: Get Extensions Status` - Check installed extension status
