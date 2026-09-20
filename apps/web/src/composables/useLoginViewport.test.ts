import { afterEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, ref } from "vue";
import { mount, type VueWrapper } from "@vue/test-utils";
import { useLoginViewport } from "./useLoginViewport";

let wrapper: VueWrapper | undefined;

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function open() {
  wrapper = mount(
    defineComponent({
      setup() {
        const container = ref<HTMLElement | null>(null);
        useLoginViewport(container);
        return () => h("main", { ref: container }, h("input"));
      },
    }),
    { attachTo: document.body },
  );
  return wrapper.element as HTMLElement;
}

describe("useLoginViewport", () => {
  it("keeps browsers without VisualViewport usable", () => {
    vi.stubGlobal("visualViewport", null);
    vi.stubGlobal("innerHeight", 568);
    const element = open();
    expect(element.style.height).toBe("568px");
    expect(element.style.top).toBe("0px");
  });

  it("cancels pending work and removes listeners when leaving login", () => {
    const viewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0 });
    vi.stubGlobal("visualViewport", viewport);
    const request = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(123);
    const cancel = vi.spyOn(window, "cancelAnimationFrame");
    const element = open();
    viewport.height = 360;
    viewport.dispatchEvent(new Event("resize"));
    viewport.dispatchEvent(new Event("scroll"));
    expect(request).toHaveBeenCalledTimes(1);
    wrapper!.unmount();
    wrapper = undefined;
    expect(cancel).toHaveBeenCalledWith(123);
    viewport.dispatchEvent(new Event("resize"));
    viewport.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("resize"));
    window.dispatchEvent(new Event("pageshow"));
    element.dispatchEvent(new Event("focusin"));
    expect(request).toHaveBeenCalledTimes(1);
    expect(element.style.height).toBe("844px");
  });
});
