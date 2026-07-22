import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appRoot = new URL("../../", import.meta.url);
const readSource = (path) => readFileSync(new URL(path, appRoot), "utf8");

const indexHtml = readSource("index.html");
const gameView = readSource("src/views/GameView.vue");
const gameRulesView = readSource("src/views/GameRulesView.vue");
const lobbyView = readSource("src/views/LobbyView.vue");
const historyView = readSource("src/views/BetHistoryView.vue");
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

  assert.doesNotMatch(
    gameView,
    /@pointerdown\.prevent="(?:stageBet|clearStagedBets|confirmStagedBets)/,
  );
  assert.match(gameView, /\.bet-cell\s*\{[\s\S]*?width: 100%;[\s\S]*?min-height: 78px;/);
  assert.match(
    gameView,
    /aria-label="重複上次投注"[\s\S]*?<span class="rebet-primary">重複<\/span>[\s\S]*?<span class="rebet-secondary">上次投注<\/span>/,
  );
  assert.match(
    gameView,
    /\.rebet-button\s*\{[\s\S]*?flex-direction: column;[\s\S]*?white-space: nowrap;/,
  );
});

test("settlement and roadmap dialogs declare modal focus behavior", () => {
  const dialogCases = [
    [gameView, "settlementDialogRef", "onSettlementDialogKeydown", "settlementCloseButtonRef"],
    [gameView, "roadmapDialogRef", "onRoadmapDialogKeydown", "roadmapCloseButtonRef"],
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

test("bet history is a keyboard-accessible page instead of a modal", () => {
  assert.match(historyView, /<main class="player-page history-page">/);
  assert.match(historyView, /<h1>投注紀錄<\/h1>/);
  assert.match(
    historyView,
    /<button\s+class="page-header-back history-back"\s+type="button"\s+aria-label="返回"/,
  );
  assert.doesNotMatch(historyView, /role="dialog"|aria-modal="true"|history-modal/);
  assert.doesNotMatch(lobbyView, /account-button|history-button|header-actions|history-modal/);
});

test("player pages share the same outer layout", () => {
  assert.match(lobbyView, /<main class="player-page page-shell lobby-page">/);
  assert.match(historyView, /<main class="player-page history-page">/);
  assert.match(gameView, /<main class="player-page page-shell game-page">/);
  assert.match(
    gameView,
    /<div class="table-nav-heading">[\s\S]*?<h1>[\s\S]*?<p class="table-meta-line">/,
  );
  assert.match(
    globalStyles,
    /\.player-page\s*\{[\s\S]*?gap: \$space-2;[\s\S]*?padding: 0 12px[^;]*;/,
  );
});

test("game rules replace settings with a dedicated accessible page", () => {
  assert.match(
    gameView,
    /<button class="nav-text-button" type="button" @click="openGameRules">遊戲規則<\/button>/,
  );
  assert.doesNotMatch(gameView, /openRoadSettings|isRoadSettingsOpen|road-settings-title|>設定</);
  assert.match(gameRulesView, /<main class="player-page rules-page">/);
  assert.match(gameRulesView, /<h1>遊戲規則<\/h1>/);
  assert.match(gameRulesView, /<table class="fortune-table">/);
  assert.doesNotMatch(gameRulesView, /\.rules-header\s*\{[^}]*position:\s*fixed;/);
  assert.match(gameRulesView, /\.rules-content\s*\{[^}]*max-width: 560px;[^}]*margin: 0 auto;/);
});

test("important async updates expose polite live regions", () => {
  assert.match(
    gameView,
    /class="game-message-toast"\s+role="status"\s+aria-live="polite"\s+aria-atomic="true"/,
  );
  assert.match(gameView, /\{\{ bettingStatusAnnouncement \}\}/);
  assert.match(gameView, /已選下注總額/);
  assert.match(gameView, /class="score-row"[^>]+aria-live="polite"[^>]+aria-atomic="true"/);
  assert.match(lobbyView, /class="lobby-loading-panel panel"\s+role="status"\s+aria-live="polite"/);
});

test("visible focus and primary touch targets remain accessible", () => {
  assert.match(globalStyles, /button:focus-visible,[\s\S]*?outline: 3px solid \$color-gold;/);
  assert.match(globalStyles, /\[tabindex\]:focus-visible/);
  assert.match(
    globalStyles,
    /\.page-header\s*\{[\s\S]*?grid-template-columns: 40px minmax\(0, 1fr\) 40px;[\s\S]*?min-height: 64px;/,
  );
  assert.match(globalStyles, /\.page-header-back\s*\{[\s\S]*?width: 40px;[\s\S]*?height: 40px;/);
  assert.match(gameView, /\.toolbar-round-button\s*\{[\s\S]*?width: 44px;[\s\S]*?height: 44px;/);
  assert.match(gameView, /\.modal-close-button\s*\{[\s\S]*?width: 44px;[\s\S]*?height: 44px;/);
});
