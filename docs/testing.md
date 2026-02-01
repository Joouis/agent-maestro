# Testing Guide

Agent Maestro uses the VS Code testing framework with Mocha. Tests ensure that changes don't break existing functionality.

## Running Tests

```bash
# Run all tests (includes build, lint, and type checking)
pnpm test

# Build tests only
pnpm run build-tests

# Watch tests during development
pnpm run watch-tests
```

## Test Coverage Summary

| Test File                         | Tests | What It Covers                                            |
| --------------------------------- | ----- | --------------------------------------------------------- |
| `extension.test.ts`               | 12    | Extension activation, command registration, configuration |
| `copilotFixer.test.ts`            | 12    | Copilot header removal, backup/restore functionality      |
| `utils/config.test.ts`            | 5     | Configuration defaults and reading                        |
| `utils/mimeTypes.test.ts`         | 12    | MIME type detection for file extensions                   |
| `utils/rooSettingsFilter.test.ts` | 5     | API key filtering from settings                           |
| `utils/updateEnvFile.test.ts`     | 13    | .env file creation/update logic                           |
| `schemas/cline.test.ts`           | 6     | Cline API request/response validation                     |
| `schemas/roo.test.ts`             | 7     | Roo API request/response validation                       |
| `schemas/common.test.ts`          | 7     | Common schemas (file ops, extension info, OS info)        |
| `server/anthropic.test.ts`        | 23    | Anthropic → VS Code message conversion                    |
| `server/openaiChat.test.ts`       | 15    | OpenAI → VS Code message conversion                       |
| `server/openaiResponses.test.ts`  | 45    | OpenAI Responses → VS Code conversion                     |
| `server/gemini.test.ts`           | 27    | Gemini → VS Code message conversion                       |

## How Tests Prevent Regressions

1. **Extension Core** - Tests verify all commands register correctly and the extension activates without errors.

2. **Schema Validation** - Zod schemas define the API contract. Tests ensure valid requests pass and invalid ones fail.

3. **API Conversion Logic** - The proxy server translates between OpenAI/Anthropic/Gemini formats and VS Code's chat API. Tests verify:

   - Message roles convert correctly (user/assistant/system)
   - Tool calls and tool results are preserved
   - Edge cases like empty arrays don't crash

4. **Utility Functions** - Tests cover pure functions:
   - MIME type detection for file uploads
   - Settings filtering (ensuring API keys don't leak)
   - .env file manipulation

## Regression Prevention Workflow

Before committing any changes, run:

```bash
pnpm test
```

This command:

1. Compiles all test files
2. Builds the extension
3. Runs ESLint
4. Executes all tests

If any test fails, the command exits with a non-zero code.

## Test Structure

```
src/test/
├── extension.test.ts          # Extension activation and commands
├── copilotFixer.test.ts       # Copilot Chat fix functionality
├── schemas/                   # Zod schema validation tests
│   ├── cline.test.ts
│   ├── common.test.ts
│   └── roo.test.ts
├── server/                    # API conversion utilities tests
│   ├── anthropic.test.ts
│   ├── gemini.test.ts
│   ├── openaiChat.test.ts
│   └── openaiResponses.test.ts
└── utils/                     # Utility function tests
    ├── config.test.ts
    ├── mimeTypes.test.ts
    ├── rooSettingsFilter.test.ts
    └── updateEnvFile.test.ts
```

## Writing Tests

### Test Template

```typescript
import * as assert from "assert";

suite("FeatureName Test Suite", () => {
  suite("functionOrClassName", () => {
    test("should do expected behavior", () => {
      const input = {
        /* test data */
      };
      const result = functionToTest(input);
      assert.strictEqual(result.success, true);
    });
  });
});
```

### Test Hooks

Use Mocha hooks for setup and teardown:

```typescript
suite("Test Suite with Hooks", () => {
  const testDir = path.join(os.tmpdir(), "test-data");

  setup(() => {
    fs.mkdirSync(testDir, { recursive: true });
  });

  teardown(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  test("test case", () => {
    // Your test
  });
});
```

### Best Practices

1. **Descriptive Names**: Use clear test names like `"should return error when API key is missing"`

2. **Test Edge Cases**: Include tests for empty inputs, invalid inputs, and error conditions

3. **Avoid Test Dependencies**: Tests should run independently

4. **Clean Up Resources**: Always clean up created files in `teardown`
