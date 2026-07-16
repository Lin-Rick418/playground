import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { extname } from "node:path";

const textExtensions = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".scss",
  ".ts",
  ".vue",
  ".yaml",
  ".yml",
]);
const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean)
  .filter((file) => textExtensions.has(extname(file)));
const errors = [];

for (const file of files) {
  const contents = readFileSync(file, "utf8");

  if (/[ \t]+$/m.test(contents)) {
    errors.push(`${file}: trailing whitespace`);
  }

  if (/^(?:<{7}|={7}|>{7})(?: |$)/m.test(contents)) {
    errors.push(`${file}: unresolved merge conflict marker`);
  }

  if (!contents.endsWith("\n")) {
    errors.push(`${file}: missing final newline`);
  }

  if (/test/i.test(file) && /\b(?:describe|it|test)\.(?:only|skip)\s*\(/.test(contents)) {
    errors.push(`${file}: focused or skipped test is not allowed in CI`);
  }
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Static repository checks passed for ${files.length} text files`);
}
