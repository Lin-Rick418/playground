import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { BET_OPTIONS } from "../const/game";
import type { BetType } from "../types/domain";
import BetOptionGrid from "./BetOptionGrid.vue";

function betAmounts(overrides: Partial<Record<BetType, number>> = {}): Record<BetType, number> {
  return {
    PLAYER: 0,
    BANKER: 0,
    TIE: 0,
    PLAYER_PAIR: 0,
    BANKER_PAIR: 0,
    ...overrides,
  };
}

describe("BetOptionGrid", () => {
  it("renders accessible bet state and emits the selected bet type", async () => {
    const wrapper = mount(BetOptionGrid, {
      props: {
        options: BET_OPTIONS.filter((option) => ["PLAYER", "BANKER"].includes(option.key)),
        variant: "main",
        amounts: betAmounts({ PLAYER: 1_500 }),
        stagedAmounts: betAmounts({ PLAYER: 500 }),
        selectedChip: 500,
        disabled: false,
        closed: false,
      },
    });

    const playerButton = wrapper.get('button[aria-label^="閒"]');
    expect(playerButton.attributes("aria-label")).toBe(
      "閒，賠率 1:1，每次增加 500，目前下注 1,500",
    );
    expect(playerButton.get(".bet-cell-amount").text()).toBe("1.5k");
    expect(playerButton.get(".bet-cell-amount").classes()).toContain("staged");

    await playerButton.trigger("click");
    expect(wrapper.emitted("select")).toEqual([["PLAYER"]]);
  });

  it("preserves disabled and empty states", () => {
    const wrapper = mount(BetOptionGrid, {
      props: {
        options: BET_OPTIONS.filter((option) => option.key === "TIE"),
        variant: "side",
        amounts: betAmounts(),
        stagedAmounts: betAmounts(),
        selectedChip: 100,
        disabled: true,
        closed: true,
      },
    });

    expect(wrapper.get("button").attributes()).toHaveProperty("disabled");
    expect(wrapper.get(".bet-row").classes()).toContain("closed");
    expect(wrapper.get(".bet-cell-amount").classes()).toContain("empty");
    expect(wrapper.get(".bet-cell-amount").text()).toBe("");
  });
});
