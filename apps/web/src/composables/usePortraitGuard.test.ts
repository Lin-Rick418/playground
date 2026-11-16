import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import { defineComponent, h, nextTick, ref } from "vue";
import { providePortraitGuard, usePortraitBlocked } from "./usePortraitGuard";

describe("mobile portrait guard", () => {
  let wrapper: VueWrapper | undefined;
  let orientation: EventTarget & { type: string };
  const enabled = ref(true);
  const Child = defineComponent({
    setup() {
      const blocked = usePortraitBlocked();
      return () => h("output", blocked.value ? "blocked" : "playable");
    },
  });
  function open() {
    wrapper = mount(
      defineComponent({
        setup() {
          providePortraitGuard(() => enabled.value);
          return () => h(Child);
        },
      }),
    );
    return wrapper;
  }
  beforeEach(() => {
    enabled.value = true;
    orientation = Object.assign(new EventTarget(), { type: "portrait-primary" });
    vi.stubGlobal("screen", { orientation, width: 390, height: 844 });
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("iPhone");
    vi.spyOn(navigator, "maxTouchPoints", "get").mockReturnValue(5);
  });
  afterEach(() => {
    wrapper?.unmount();
    wrapper = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  it("blocks both landscape directions, restores portrait, and respects route scope", async () => {
    const view = open();
    expect(view.text()).toBe("playable");
    for (const type of ["landscape-primary", "landscape-secondary"]) {
      orientation.type = type;
      orientation.dispatchEvent(new Event("change"));
      await nextTick();
      expect(view.text()).toBe("blocked");
    }
    enabled.value = false;
    await nextTick();
    expect(view.text()).toBe("playable");
    enabled.value = true;
    orientation.type = "portrait-secondary";
    orientation.dispatchEvent(new Event("change"));
    await nextTick();
    expect(view.text()).toBe("playable");
  });
  it.each(["Windows NT", "Macintosh"])("does not block a wide %s desktop", (ua) => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ua);
    vi.spyOn(navigator, "maxTouchPoints", "get").mockReturnValue(0);
    orientation.type = "landscape-primary";
    expect(open().text()).toBe("playable");
  });
  it.each(["Android", "Macintosh"])("recognizes mobile/tablet devices with %s UA", (ua) => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ua);
    orientation.type = "landscape-primary";
    expect(open().text()).toBe("blocked");
  });
  it("does not interpret the portrait soft keyboard as rotation", async () => {
    const view = open();
    vi.stubGlobal("innerWidth", 390);
    vi.stubGlobal("innerHeight", 280);
    window.dispatchEvent(new Event("resize"));
    await nextTick();
    expect(view.text()).toBe("playable");
  });
  it("uses legacy device orientation and screen dimensions without modern orientation support", async () => {
    vi.stubGlobal("screen", { width: 390, height: 844 });
    vi.stubGlobal("orientation", -90);
    const view = open();
    expect(view.text()).toBe("blocked");
    vi.stubGlobal("orientation", 0);
    window.dispatchEvent(new Event("orientationchange"));
    await nextTick();
    expect(view.text()).toBe("playable");
    vi.stubGlobal("orientation", undefined);
    vi.stubGlobal("screen", { width: 844, height: 390 });
    window.dispatchEvent(new Event("resize"));
    await nextTick();
    expect(view.text()).toBe("blocked");
  });
  it("removes orientation and window listeners on unmount", () => {
    const removeOrientation = vi.spyOn(orientation, "removeEventListener");
    const removeWindow = vi.spyOn(window, "removeEventListener");
    open().unmount();
    wrapper = undefined;
    expect(removeOrientation).toHaveBeenCalledWith("change", expect.any(Function));
    for (const name of ["orientationchange", "resize", "pageshow"])
      expect(removeWindow).toHaveBeenCalledWith(name, expect.any(Function));
  });
});
