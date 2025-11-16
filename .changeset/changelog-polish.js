import fs from "fs";

const path = "CHANGELOG.md";
let text = fs.readFileSync(path, "utf8");

// 1. Turn "## 0.4.0" into "## v0.4.0 - YYYY.MM.DD"
const today = new Date().toISOString().split("T")[0].replace(/-/g, ".");
text = text.replace(
  /^##\s*(\d+\.\d+\.\d+)/m,
  (_, ver) => `## v${ver} - ${today}`,
);

// 2. Remove section headings like "### Minor Changes" and "### Patch Changes"
text = text.replace(
  /^###\s+(Minor Changes|Patch Changes|Major Changes)\s*\n\n/gm,
  "",
);

// 3. Remove blank lines between bullet points to prevent spacing between sections
text = text.replace(/^- .+(?:\n+)- /gm, (match) => match.replace(/\n+/g, "\n"));

fs.writeFileSync(path, text, "utf8");
