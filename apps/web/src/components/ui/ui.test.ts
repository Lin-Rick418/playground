import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import AppButton from "./AppButton.vue";
import AppInput from "./AppInput.vue";
import AppSelect from "./AppSelect.vue";
import AppPageHeader from "./AppPageHeader.vue";
import StakeControl from "./StakeControl.vue";
import BalanceBar from "./BalanceBar.vue";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("shared player controls", () => {
  it("forwards button events and accessible names, defaults to non-submit, and blocks busy clicks", async () => {
    const click = vi.fn();
    const view = mount(AppButton, {
      attrs: { "aria-label": "關閉", onClick: click },
      props: { icon: true },
      attachTo: document.body,
    });
    try {
      expect(view.get("button").attributes("type")).toBe("button");
      expect(view.get("button").attributes("aria-label")).toBe("關閉");
      view.vm.focus();
      expect(document.activeElement).toBe(view.element);
      await view.get("button").trigger("click");
      expect(click).toHaveBeenCalledTimes(1);
      await view.setProps({ busy: true });
      (view.element as HTMLButtonElement).click();
      expect(click).toHaveBeenCalledTimes(1);
      expect(view.attributes("aria-busy")).toBe("true");
    } finally {
      view.unmount();
    }
  });
  it("keeps numeric select models numeric and forwards native form attributes", async () => {
    const view = mount(AppSelect, {
      props: { modelValue: 100 },
      attrs: { name: "stake", disabled: false, "aria-label": "投注額" },
      slots: { default: '<option value="100">100</option><option value="200">200</option>' },
    });
    await view.get("select").setValue("200");
    expect(view.emitted("update:modelValue")?.[0]).toEqual([200]);
    expect(view.attributes("name")).toBe("stake");
    view.unmount();
  });
  it("preserves password fields and trim model modifiers", async () => {
    const view = mount(AppInput, {
      props: { modelValue: "", modelModifiers: { trim: true } },
      attrs: { type: "password", autocomplete: "current-password", required: true },
    });
    await view.get("input").setValue(" abc123 ");
    expect(view.emitted("update:modelValue")?.[0]).toEqual(["abc123"]);
    expect(view.attributes("type")).toBe("password");
    expect(view.attributes("autocomplete")).toBe("current-password");
    view.unmount();
  });
  it("renders a named heading, a labeled return button and separate subtitle/actions", async () => {
    const view = mount(AppPageHeader, {
      props: { title: "百家樂", backLabel: "返回大廳" },
      slots: {
        subtitle: "<p>限紅 100–5,000</p>",
        actions: '<button type="button">遊戲規則</button>',
      },
    });
    expect(view.get("h1").text()).toBe("百家樂");
    await view.get('button[aria-label="返回大廳"]').trigger("click");
    expect(view.emitted("back")).toHaveLength(1);
    expect(view.get(".page-header-subtitle").text()).toContain("限紅");
    view.unmount();
  });
  it("applies stake limits and emits changes from the select and shortcuts", async () => {
    const view = mount(StakeControl, { props: { modelValue: 100, min: 100, max: 500, step: 100 } });
    expect(view.get('button[aria-label="減少投注 100"]').attributes("disabled")).toBeDefined();
    await view.get('button[aria-label="增加投注 100"]').trigger("click");
    expect(view.emitted("update:modelValue")?.at(-1)).toEqual([200]);
    await view.get("select").setValue("400");
    expect(view.emitted("update:modelValue")?.at(-1)).toEqual([400]);
    await view.setProps({ modelValue: 500 });
    expect(view.get('button[aria-label="最高投注 500"]').attributes("disabled")).toBeDefined();
    await view.setProps({ disabled: true });
    expect(
      view.findAll("button, select").every((el) => el.attributes("disabled") !== undefined),
    ).toBe(true);
    view.unmount();
  });
  it("restarts the wallet warning, preserves displayed balance, and cleans up on unmount", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    const view = mount(BalanceBar, { props: { balance: 1234.56, rolling: true } });
    view.vm.warn();
    await view.vm.$nextTick();
    expect(view.get('[role="alert"]').text()).toBe("餘額不足");
    expect(view.get("strong").text()).toBe("$1,234");
    await vi.advanceTimersByTimeAsync(800);
    view.vm.warn();
    await vi.advanceTimersByTimeAsync(800);
    expect(view.find('[role="alert"]').exists()).toBe(true);
    await vi.advanceTimersByTimeAsync(400);
    expect(view.find('[role="alert"]').exists()).toBe(false);
    view.vm.warn();
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
