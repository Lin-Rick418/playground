import { mount, flushPromises } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PwaInstall from "./PwaInstall.vue";
import PwaNetworkStatus from "./PwaNetworkStatus.vue";
import { initializePwa } from "../lib/pwa";

let dispose: () => void;
const wrappers: ReturnType<typeof mount>[] = [];
let display: EventTarget & { matches: boolean };
function render() {
  const wrapper = mount(PwaInstall);
  wrappers.push(wrapper);
  return wrapper;
}
function installEvent(
  outcome: "accepted" | "dismissed" = "dismissed",
  prompt = vi.fn().mockResolvedValue(undefined),
) {
  const event = new Event("beforeinstallprompt", { cancelable: true });
  Object.assign(event, { prompt, userChoice: Promise.resolve({ outcome }) });
  window.dispatchEvent(event);
  return { event, prompt };
}
beforeEach(() => {
  display = Object.assign(new EventTarget(), { matches: false });
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => display),
  );
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Chrome");
  dispose = initializePwa();
});
afterEach(() => {
  wrappers.splice(0).forEach((w) => w.unmount());
  dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PWA installation", () => {
  it("renders nothing when installation is unavailable", () => {
    const wrapper = render();
    expect(wrapper.find("button").exists()).toBe(false);
    expect(wrapper.find("section").exists()).toBe(false);
  });
  it("only prompts on a click and waits for a fresh event after dismissal", async () => {
    const wrapper = render();
    const { event, prompt } = installEvent();
    await flushPromises();
    expect(event.defaultPrevented).toBe(true);
    expect(prompt).not.toHaveBeenCalled();
    await wrapper.get("button").trigger("click");
    await flushPromises();
    expect(prompt).toHaveBeenCalledOnce();
    expect(wrapper.find("button").exists()).toBe(false);
    installEvent();
    await flushPromises();
    expect(wrapper.get("button").text()).toBe("安裝 Casino");
  });
  it("hides the entry on appinstalled", async () => {
    const wrapper = render();
    installEvent("accepted");
    await flushPromises();
    await wrapper.get("button").trigger("click");
    window.dispatchEvent(new Event("appinstalled"));
    await flushPromises();
    expect(wrapper.find("section").exists()).toBe(false);
  });
  it("handles an expired prompt without rejecting the click", async () => {
    const wrapper = render();
    installEvent("dismissed", vi.fn().mockRejectedValue(new Error("expired")));
    await flushPromises();
    await wrapper.get("button").trigger("click");
    await flushPromises();
    expect(wrapper.find("section").exists()).toBe(false);
  });
  it("hides the entry in standalone mode, including changes", async () => {
    const wrapper = render();
    display.matches = true;
    display.dispatchEvent(new Event("change"));
    await flushPromises();
    expect(wrapper.find("section").exists()).toBe(false);
  });
  it("shows and clears the offline status without reloading", async () => {
    const wrapper = mount(PwaNetworkStatus);
    wrappers.push(wrapper);
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    window.dispatchEvent(new Event("offline"));
    await flushPromises();
    expect(wrapper.get('[role="status"]').text()).toContain("已離線");
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    window.dispatchEvent(new Event("online"));
    await flushPromises();
    expect(wrapper.find("aside").exists()).toBe(false);
  });
});
