import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appRoot = new URL("../../", import.meta.url);
const indexHtml = readFileSync(new URL("index.html", appRoot), "utf8");
const globalStyles = readFileSync(new URL("src/style.scss", appRoot), "utf8");

test("initial paint has an inline app background before the JavaScript entry", () => {
  const bootstrapStyleIndex = indexHtml.indexOf("<style>");
  const appEntryIndex = indexHtml.indexOf('<script type="module" src="/src/main.ts"></script>');

  assert.notEqual(bootstrapStyleIndex, -1, "缺少首屏 bootstrap style");
  assert.notEqual(appEntryIndex, -1, "缺少 app entry script");
  assert.ok(bootstrapStyleIndex < appEntryIndex, "首屏背景必須在 app script 前可用");
  assert.match(indexHtml, /<meta name="theme-color" content="#1f6a45"\s*\/>/);
  assert.match(
    indexHtml,
    /body\s*\{[\s\S]*?min-height: 100vh;[\s\S]*?margin: 0;[\s\S]*?linear-gradient\(180deg, #37996a 0%, #2c8258 46%, #1f6a45 100%\);/,
  );
  assert.match(indexHtml, /#app\s*\{[\s\S]*?min-height: 100vh;/);
});

test("global CSS does not depend on a runtime web-font stylesheet", () => {
  assert.doesNotMatch(globalStyles, /@import\s+url\(/);
  assert.doesNotMatch(globalStyles, /fonts\.(?:googleapis|gstatic)\.com/);
  assert.match(
    globalStyles,
    /font-family:\s*-apple-system,\s*BlinkMacSystemFont,\s*"Segoe UI",\s*"PingFang TC",\s*"Microsoft JhengHei",\s*sans-serif;/,
  );
});
