import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appRoot = new URL("../../", import.meta.url);
const readSource = (path) => readFileSync(new URL(path, appRoot), "utf8");

const indexHtml = readSource("index.html");
const gameView = readSource("src/views/GameView.vue");
const lobbyView = readSource("src/views/LobbyView.vue");
const dialogFocus = readSource("src/composables/useDialogFocus.ts");
const globalStyles = readSource("src/style.scss");

function openingTagForMarker(source, marker) {
  const markerIndex = source.indexOf(marker);
  assert.notEqual(markerIndex, -1, `找不到 ${marker}`);

  const openingTagStart = source.lastIndexOf("<", markerIndex);
  const openingTagEnd = source.indexOf(">", markerIndex);
  assert.notEqual(openingTagStart, -1, `${marker} 缺少 opening tag`);
  assert.notEqual(openingTagEnd, -1, `${marker} 缺少 closing bracket`);
  return source.slice(openingTagStart, openingTagEnd + 1);
}

test("document language and viewport preserve browser zoom", () => {
  assert.match(indexHtml, /<html lang="zh-Hant">/);

  const viewport = indexHtml.match(/<meta\s+name="viewport"\s+content="([^"]+)"/s)?.[1];
  assert.ok(viewport, "缺少 viewport meta");
  assert.doesNotMatch(viewport, /user-scalable/i);
  assert.doesNotMatch(viewport, /maximum-scale/i);
});

test("core betting areas use native keyboard-operable buttons", () => {
  for (const row of ["sideBetRow", "mainBetRow"]) {
    const openingTag = openingTagForMarker(gameView, `v-for="option in ${row}"`);
    assert.match(openingTag, /^<button\b/);
    assert.match(openingTag, /type="button"/);
    assert.match(openingTag, /:disabled="!isBettingOpen \|\| isPlacingBet"/);
    assert.match(openingTag, /:aria-label="betAreaAriaLabel\(option\)"/);
    assert.match(openingTag, /@click="stageBet\(option\.key\)"/);
  }

  assert.doesNotMatch(gameView, /@pointerdown\.prevent="(?:stageBet|clearStagedBets|confirmStagedBets)/);
  assert.match(gameView, /\.bet-cell\s*\{[\s\S]*?width: 100%;[\s\S]*?min-height: 78px;/);
});

test("history, settlement, roadmap and settings dialogs declare modal focus behavior", () => {
  const dialogCases = [
    [lobbyView, "historyDialogRef", "onHistoryDialogKeydown", "historyCloseButtonRef"],
    [gameView, "settlementDialogRef", "onSettlementDialogKeydown", "settlementCloseButtonRef"],
    [gameView, "roadmapDialogRef", "onRoadmapDialogKeydown", "roadmapCloseButtonRef"],
    [gameView, "settingsDialogRef", "onSettingsDialogKeydown", "settingsCloseButtonRef"],
  ];

  for (const [source, dialogRef, keydownHandler, closeButtonRef] of dialogCases) {
    const openingTag = openingTagForMarker(source, `ref="${dialogRef}"`);
    assert.match(openingTag, /role="dialog"/);
    assert.match(openingTag, /aria-modal="true"/);
    assert.match(openingTag, /aria-labelledby="[^"]+"/);
    assert.match(openingTag, /tabindex="-1"/);
    assert.match(openingTag, new RegExp(`@keydown="${keydownHandler}"`));
    assert.match(source, new RegExp(`ref="${closeButtonRef}"`));
  }

  assert.match(dialogFocus, /event\.key === "Escape"/);
  assert.match(dialogFocus, /event\.key !== "Tab"/);
  assert.match(dialogFocus, /previouslyFocused\.focus\(\)/);
  assert.match(dialogFocus, /lastElement\.focus\(\)/);
  assert.match(dialogFocus, /firstElement\.focus\(\)/);
});

test("important async updates expose polite live regions", () => {
  assert.match(gameView, /class="game-message-toast" role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(gameView, /\{\{ bettingStatusAnnouncement \}\}/);
  assert.match(gameView, /已選下注總額/);
  assert.match(gameView, /class="score-row"[^>]+aria-live="polite"[^>]+aria-atomic="true"/);
  assert.match(lobbyView, /class="lobby-loading-panel panel" role="status" aria-live="polite"/);
});

test("visible focus and primary touch targets remain accessible", () => {
  assert.match(globalStyles, /button:focus-visible,[\s\S]*?outline: 3px solid \$color-gold;/);
  assert.match(globalStyles, /\[tabindex\]:focus-visible/);
  assert.match(lobbyView, /\.back-button,[\s\S]*?\.history-button\s*\{[\s\S]*?width: 44px;[\s\S]*?height: 44px;/);
  assert.match(gameView, /\.nav-icon-button\s*\{[\s\S]*?width: 44px;[\s\S]*?height: 44px;/);
  assert.match(gameView, /\.toolbar-round-button\s*\{[\s\S]*?width: 44px;[\s\S]*?height: 44px;/);
  assert.match(gameView, /\.settings-close-button\s*\{[\s\S]*?width: 44px;[\s\S]*?height: 44px;/);
});
