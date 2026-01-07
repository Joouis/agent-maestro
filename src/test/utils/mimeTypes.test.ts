import * as assert from "assert";

import { getMimeType, MIME_TYPES } from "../../server/utils/mimeTypes";

suite("MimeTypes Test Suite", () => {
  suite("MIME_TYPES constant", () => {
    test("should have correct MIME types for common file extensions", () => {
      // Text files
      assert.strictEqual(MIME_TYPES[".txt"], "text/plain");
      assert.strictEqual(MIME_TYPES[".md"], "text/markdown");

      // Web technologies
      assert.strictEqual(MIME_TYPES[".html"], "text/html");
      assert.strictEqual(MIME_TYPES[".css"], "text/css");
      assert.strictEqual(MIME_TYPES[".json"], "application/json");

      // JavaScript/TypeScript
      assert.strictEqual(MIME_TYPES[".js"], "application/javascript");
      assert.strictEqual(MIME_TYPES[".ts"], "application/typescript");
      assert.strictEqual(MIME_TYPES[".jsx"], "text/jsx");
      assert.strictEqual(MIME_TYPES[".tsx"], "text/tsx");

      // Python
      assert.strictEqual(MIME_TYPES[".py"], "text/x-python");

      // Images
      assert.strictEqual(MIME_TYPES[".png"], "image/png");
      assert.strictEqual(MIME_TYPES[".jpg"], "image/jpeg");
      assert.strictEqual(MIME_TYPES[".gif"], "image/gif");
      assert.strictEqual(MIME_TYPES[".svg"], "image/svg+xml");

      // Config files
      assert.strictEqual(MIME_TYPES[".yml"], "application/yaml");
      assert.strictEqual(MIME_TYPES[".yaml"], "application/yaml");
      assert.strictEqual(MIME_TYPES[".toml"], "application/toml");
    });
  });

  suite("getMimeType", () => {
    test("should return correct MIME type for known extensions", () => {
      assert.strictEqual(getMimeType("file.txt"), "text/plain");
      assert.strictEqual(getMimeType("script.js"), "application/javascript");
      assert.strictEqual(getMimeType("styles.css"), "text/css");
      assert.strictEqual(getMimeType("data.json"), "application/json");
      assert.strictEqual(getMimeType("image.png"), "image/png");
    });

    test("should handle files with paths", () => {
      assert.strictEqual(
        getMimeType("/path/to/file.ts"),
        "application/typescript",
      );
      assert.strictEqual(getMimeType("src/components/App.tsx"), "text/tsx");
      assert.strictEqual(getMimeType("./relative/path/doc.md"), "text/markdown");
    });

    test("should handle uppercase extensions", () => {
      assert.strictEqual(getMimeType("FILE.TXT"), "text/plain");
      assert.strictEqual(getMimeType("IMAGE.PNG"), "image/png");
      assert.strictEqual(getMimeType("SCRIPT.JS"), "application/javascript");
    });

    test("should return octet-stream for unknown extensions", () => {
      assert.strictEqual(getMimeType("file.unknown"), "application/octet-stream");
      assert.strictEqual(getMimeType("file.xyz123"), "application/octet-stream");
    });

    test("should return octet-stream for files without extensions", () => {
      assert.strictEqual(getMimeType("LICENSE"), "application/octet-stream");
      assert.strictEqual(getMimeType("noextension"), "application/octet-stream");
    });

    test("should handle special files correctly", () => {
      // Dockerfile
      assert.strictEqual(getMimeType("Dockerfile"), "text/x-dockerfile");
      assert.strictEqual(getMimeType("dockerfile"), "text/x-dockerfile");

      // Makefile
      assert.strictEqual(getMimeType("Makefile"), "text/x-makefile");

      // package.json
      assert.strictEqual(getMimeType("package.json"), "application/json");

      // tsconfig.json
      assert.strictEqual(getMimeType("tsconfig.json"), "application/json");

      // Config files
      assert.strictEqual(getMimeType("webpack.config.js"), "application/javascript");
      assert.strictEqual(getMimeType("babel.config.js"), "application/javascript");
      assert.strictEqual(getMimeType("eslint.config.js"), "application/javascript");

      // RC files
      assert.strictEqual(getMimeType(".eslintrc"), "application/json");
      assert.strictEqual(getMimeType(".prettierrc"), "application/json");
      assert.strictEqual(getMimeType(".babelrc"), "application/json");
    });

    test("should handle CMakeLists.txt", () => {
      assert.strictEqual(getMimeType("CMakeLists.txt"), "text/x-cmake");
      assert.strictEqual(getMimeType("cmakelists.txt"), "text/x-cmake");
    });

    test("should handle files with multiple dots", () => {
      assert.strictEqual(getMimeType("file.test.ts"), "application/typescript");
      assert.strictEqual(getMimeType("app.module.css"), "text/css");
      assert.strictEqual(
        getMimeType("component.stories.tsx"),
        "text/tsx",
      );
    });

    test("should handle shell scripts", () => {
      assert.strictEqual(getMimeType("script.sh"), "application/x-sh");
      assert.strictEqual(getMimeType("script.bash"), "application/x-sh");
      assert.strictEqual(getMimeType("script.zsh"), "application/x-sh");
      assert.strictEqual(getMimeType("script.ps1"), "application/x-powershell");
      assert.strictEqual(getMimeType("script.bat"), "application/x-bat");
    });

    test("should handle document files", () => {
      assert.strictEqual(getMimeType("document.pdf"), "application/pdf");
      assert.strictEqual(getMimeType("document.doc"), "application/msword");
      assert.strictEqual(
        getMimeType("document.docx"),
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      );
    });

    test("should handle archive files", () => {
      assert.strictEqual(getMimeType("archive.zip"), "application/zip");
      assert.strictEqual(getMimeType("archive.tar"), "application/x-tar");
      assert.strictEqual(getMimeType("archive.gz"), "application/gzip");
      assert.strictEqual(getMimeType("archive.7z"), "application/x-7z-compressed");
    });
  });
});
