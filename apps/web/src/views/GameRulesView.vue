<script setup lang="ts">
import AppPageHeader from "../components/ui/AppPageHeader.vue";
import { useRoute, useRouter } from "vue-router";

const route = useRoute();
const router = useRouter();

const bankerDrawRules = [
  "兩牌合計為 1、2 或 10 點時，不論「閒家」增得何牌",
  "兩牌合計為 3 點時，而「閒家」所增之牌是 1、2、3、4、5、6、7、9 或 10 點",
  "兩牌合計為 4 點時，而「閒家」所增之牌是 2、3、4、5、6 或 7 點",
  "兩牌合計為 5 點時，而「閒家」所增之牌是 4、5、6 或 7 點",
  "兩牌合計為 6 點時，而「閒家」所增之牌是 6 或 7 點",
  "兩牌合計 1、2、3、4、5 或 10 點時，而「閒家」並無增牌",
];

const bankerStandRules = [
  "兩牌合計 3 點，而「閒家」所增之牌是 8 點",
  "兩牌合計 4 點，而「閒家」所增之牌是 1、8、9 或 10 點",
  "兩牌合計 5 點，而「閒家」所增之牌是 1、2、3、8、9 或 10 點",
  "兩牌合計 6 點，而「閒家」所增之牌是 1、2、3、4、5、8、9 或 10 點，或「閒家」不增牌",
  "兩牌合計 7 點、8 點或 9 點",
  "「閒家」兩牌合計 8 或 9 點（例牌）",
];

function returnToGame() {
  const tableId = encodeURIComponent(String(route.params.tableId));
  void router.push(`/game/${tableId}`);
}
</script>

<template>
  <main class="player-page rules-page">
    <AppPageHeader
      class="rules-header"
      title="遊戲規則"
      back-label="返回遊戲桌"
      @back="returnToGame"
    />

    <div class="rules-content">
      <article class="rules-section" aria-labelledby="rules-introduction">
        <h2 id="rules-introduction" class="rules-section-title">簡介</h2>
        <p>本「百家樂」遊戲係以澳門博彩監察協調局頒佈的《百家樂法定規章》為核心規則的撲克遊戲；</p>
        <p>遊戲中玩家以 B 幣選擇，中獎後贏得 B 幣；</p>
        <p>
          《百家樂法定規章》可前往
          <a
            href="https://www.dicj.gov.mo/web/cn/rules/Bacara.html"
            target="_blank"
            rel="noopener noreferrer"
          >
            澳門博彩監察協調局頒佈官網查閱 &gt;
          </a>
        </p>
      </article>

      <article class="rules-section" aria-labelledby="rules-gameplay">
        <h2 id="rules-gameplay" class="rules-section-title">玩法</h2>
        <p>玩家先從活動主頁列出的多個「遊戲廳」任選一張進行遊戲；</p>
        <p>玩家進入「遊戲廳」後，遊戲以「局」為單位進行，每局遊戲中，玩家可以做的動作就是選擇；</p>
        <p>選擇項主要有：</p>
        <ul class="bet-label-list primary-bets" aria-label="主要投注項">
          <li class="bet-label player">閒</li>
          <li class="bet-label banker">莊</li>
        </ul>
        <p>額外選擇項有：</p>
        <ul class="bet-label-list side-bets" aria-label="額外投注項">
          <li class="bet-label">閒對子</li>
          <li class="bet-label">和局</li>
          <li class="bet-label">莊對子</li>
        </ul>
        <p>各項投注判定規則詳見隨後的幾個小節；</p>
        <p>玩家可以參考「路單」投注，以提升自己的勝率；</p>
        <p>投注時間截止后，系統公佈結果，與玩家結算B幣。</p>
      </article>

      <article class="rules-section" aria-labelledby="rules-prize">
        <h2 id="rules-prize" class="rules-section-title">B幣</h2>
        <p>平臺上各選項中的 1：x 為投注中彩 B 幣賠率。</p>
        <p>
          舉例：「和局」賠率為 1：8<br />如若投中，將在收回本金的同時，額外獲得 8 倍於本金的 B 幣<br />比如下注
          100 B 幣，最終將獲得 900 B 幣。
        </p>
      </article>

      <article class="rules-section" aria-labelledby="rules-card-points">
        <h2 id="rules-card-points" class="rules-section-title">紙牌點數</h2>
        <p>紙牌的點數按照下列標準：</p>
        <p>（一）人形紙牌，10 及合計十點者，俱作零點。</p>
        <p>（二）其餘的則照牌面點數計算，而牌面 9 點者為最大點數紙牌。</p>
      </article>

      <article class="rules-section compact-section" aria-labelledby="rules-winner">
        <h2 id="rules-winner" class="rules-section-title wide">莊贏、閒贏的判定</h2>
        <p>「莊」、「閒」兩家，牌局結束時持最高點數者勝。</p>
      </article>

      <article class="rules-section compact-section" aria-labelledby="rules-tie">
        <h2 id="rules-tie" class="rules-section-title wide">和局的判定和處理</h2>
        <p>牌局結束時，「莊」、「閒」兩家點數相同作和計；</p>
        <p>遇此情況時，玩家如投注了「莊」或「閒」，這部分的投注將返還給玩家；</p>
      </article>

      <article class="rules-section" aria-labelledby="rules-pair">
        <h2 id="rules-pair" class="rules-section-title extra-wide">莊對子、閒對子的判定</h2>
        <p>
          「莊對子」或「閒對子」是指任何一家的首兩張紙牌組成一對（不管何種顏色或花色，兩張紙牌點數相同湊成一對，如兩張
          J 牌成一對，但 J 牌和 Q 牌則不成一對）；
        </p>
        <div class="pair-examples" aria-label="對子判定範例">
          <div class="pair-example" aria-label="兩張 J，構成對子">
            <span class="sample-card red"><b>J</b><i>♥</i></span>
            <span class="sample-card"><b>J</b><i>♠</i></span>
            <strong class="pair-result correct" aria-hidden="true">✓</strong>
          </div>
          <div class="pair-example" aria-label="J 與 Q，不構成對子">
            <span class="sample-card red"><b>J</b><i>♥</i></span>
            <span class="sample-card"><b>Q</b><i>♠</i></span>
            <strong class="pair-result incorrect" aria-hidden="true">×</strong>
          </div>
        </div>
      </article>

      <article class="rules-section" aria-labelledby="rules-deck">
        <h2 id="rules-deck" class="rules-section-title">用牌</h2>
        <p>本遊戲使用八副牌，除去大小王，每副五十二張；</p>
        <p>開始時，系統先將牌洗勻，然後按用牌多少副，銷去同數目之牌張（即 8 張牌）；</p>
        <p>牌源至少於 12 張時，乃最後一局，待該局完畢，重新洗牌。</p>
      </article>

      <article class="rules-section compact-section" aria-labelledby="rules-deal">
        <h2 id="rules-deal" class="rules-section-title">派牌</h2>
        <p>
          開始時，系統從「閒」家起，然後是「莊」家，以交替形式一次一張地派，每家派發兩張紙牌，閒家先開牌。
        </p>
      </article>

      <article class="rules-section" aria-labelledby="rules-draw">
        <h2 id="rules-draw" class="rules-section-title">增牌</h2>
        <p>每家只限增牌一張，先派「閒家」。增牌與否，必須根據下列規則：</p>
        <h3>（一）「閒家」在下列情況下必須增牌：</h3>
        <div class="rule-row">兩牌合計 1、2、3、4、5 或 10 點</div>
        <h3>（二）「閒家」在下列情況下不得增牌：</h3>
        <div class="rule-row">兩牌合計 6、7 或 8、9 點，或「莊家」兩牌合計 8、9 點（例牌）</div>
        <h3>（三）「莊家」在下列情況下必須增牌：</h3>
        <ul class="rule-table" aria-label="莊家必須增牌規則">
          <li v-for="rule in bankerDrawRules" :key="rule">{{ rule }}</li>
        </ul>
        <h3>（四）「莊家」在下列情況下不得增牌：</h3>
        <ul class="rule-table" aria-label="莊家不得增牌規則">
          <li v-for="rule in bankerStandRules" :key="rule">{{ rule }}</li>
        </ul>
      </article>
    </div>
  </main>
</template>

<style scoped lang="scss">
.rules-page {
  min-height: 100vh;
  min-height: 100dvh;
  background: #4fb17c;
  color: #7b351f;
}

.rules-header {
  background: #4fb17c;
}

.rules-back {
  color: rgba(255, 255, 255, 0.94);
}

.rules-content {
  display: flex;
  flex-direction: column;
  gap: 38px;
  width: 100%;
  max-width: 560px;
  margin: 0 auto;
  padding: 30px 0 34px;
}

.rules-section {
  position: relative;
  border-radius: 12px;
  background: #fffbea;
  padding: 48px 20px 24px;
  box-shadow: 0 2px 5px rgba(92, 55, 16, 0.12);
}

.rules-section.compact-section {
  padding-top: 44px;
}

.rules-section-title {
  position: absolute;
  top: 0;
  left: 50%;
  z-index: 1;
  min-width: 132px;
  max-width: calc(100% - 32px);
  margin: 0;
  padding: 7px 28px 8px;
  transform: translate(-50%, -50%);
  border: 1px solid rgba(255, 205, 111, 0.5);
  border-radius: 22px 22px 18px 18px;
  background: linear-gradient(180deg, #d77b31 0%, #bc5527 56%, #a33f22 100%);
  color: #ffe9a4;
  font-size: 20px;
  font-weight: 900;
  line-height: 1.25;
  letter-spacing: 0.04em;
  text-align: center;
  text-shadow: 0 1px 1px rgba(91, 31, 13, 0.8);
  white-space: nowrap;
  box-shadow:
    0 4px 0 #8f351d,
    0 8px 10px rgba(86, 43, 12, 0.2),
    inset 0 1px 0 rgba(255, 224, 143, 0.5);
}

.rules-section-title.wide {
  min-width: 212px;
}

.rules-section-title.extra-wide {
  min-width: min(270px, calc(100% - 32px));
}

.rules-section p {
  margin: 0 0 14px;
  font-size: 15px;
  font-weight: 600;
  line-height: 1.9;
  letter-spacing: 0.035em;
}

.rules-section p:last-child {
  margin-bottom: 0;
}

.rules-section a {
  color: #1555c2;
  text-decoration: underline;
  text-underline-offset: 2px;
}

.bet-label-list {
  display: grid;
  margin: 0 0 18px;
  padding: 0;
  list-style: none;
}

.primary-bets {
  grid-template-columns: repeat(2, minmax(72px, 92px));
  justify-content: center;
  gap: 42px;
}

.side-bets {
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.bet-label {
  display: flex;
  min-height: 52px;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  background: #fff3de;
  color: #9a5a3b;
  font-size: 19px;
  font-weight: 900;
  text-align: center;
}

.primary-bets .bet-label {
  min-height: 66px;
  font-size: 34px;
}

.bet-label.player {
  color: #0874c9;
}

.bet-label.banker {
  color: #e52d37;
}

.pair-examples {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  margin-top: 16px;
}

.pair-example {
  position: relative;
  display: flex;
  justify-content: center;
  gap: 5px;
  min-width: 0;
  padding-top: 6px;
}

.sample-card {
  display: flex;
  width: 42px;
  height: 58px;
  flex-direction: column;
  border: 1px solid #d5d5d5;
  border-radius: 5px;
  background: #fff;
  padding: 4px;
  color: #1f1f1f;
  font-size: 15px;
  line-height: 1;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
}

.sample-card.red {
  color: #c82e35;
}

.sample-card i {
  margin-top: 3px;
  font-size: 18px;
  font-style: normal;
}

.pair-result {
  position: absolute;
  top: -5px;
  right: 3px;
  font-family: Arial, sans-serif;
  font-size: 48px;
  line-height: 1;
  transform: rotate(-6deg);
  -webkit-text-stroke: 1px rgba(44, 66, 35, 0.25);
  text-shadow: 0 3px 3px rgba(0, 0, 0, 0.22);
}

.pair-result.correct {
  color: #66be4b;
}

.pair-result.incorrect {
  color: #ec5350;
}

.rules-section h3 {
  margin: 18px 0 10px;
  color: #77331e;
  font-size: 15px;
  font-weight: 800;
  line-height: 1.7;
}

.rule-row,
.rule-table li {
  background: rgba(216, 211, 188, 0.52);
  color: #686257;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.45;
}

.rule-row {
  padding: 12px;
}

.rule-table {
  margin: 0;
  padding: 0;
  list-style: none;
}

.rule-table li {
  padding: 10px 12px;
}

.rule-table li:nth-child(even) {
  background: rgba(231, 232, 210, 0.62);
}

@media (max-width: 350px) {
  .rules-section {
    padding-right: 16px;
    padding-left: 16px;
  }

  .rules-section p,
  .rules-section h3 {
    font-size: 14px;
  }

  .rules-section-title {
    font-size: 18px;
  }

  .primary-bets {
    gap: 24px;
  }

  .side-bets .bet-label {
    font-size: 16px;
  }
}
</style>
