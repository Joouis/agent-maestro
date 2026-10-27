import { defineConfig } from "@vscode/test-cli";

export default defineConfig({
  files: "out/test/**/*.test.js",
  launchArgs: ["--enable-proposed-api=joouis.agent-maestro"],
});
