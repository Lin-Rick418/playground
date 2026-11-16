import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import StormGuardian from "./StormGuardian.vue";

afterEach(() => vi.restoreAllMocks());
describe("guardian visibility lifecycle", () => {
  it("pauses on a hidden document and removes its listener on unmount", async () => {
    const remove = vi.spyOn(document, "removeEventListener");
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    const wrapper = mount(StormGuardian, { props: { active: true, paused: false } });
    expect(wrapper.classes()).not.toContain("is-paused");
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));
    await wrapper.vm.$nextTick();
    expect(wrapper.classes()).toContain("is-paused");
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    document.dispatchEvent(new Event("visibilitychange"));
    await wrapper.vm.$nextTick();
    expect(wrapper.classes()).not.toContain("is-paused");
    wrapper.unmount();
    expect(remove).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
  });
});
