import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, ref } from "vue";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { useScreenWakeLock } from "./useScreenWakeLock";

class Lock extends EventTarget {
  released = false;
  release = vi.fn(async () => {
    this.released = true;
    this.dispatchEvent(new Event("release"));
  });
}

describe("useScreenWakeLock", () => {
  let wrapper: VueWrapper | undefined;
  const enabled = ref(true);
  let locks: Lock[];
  const request = vi.fn();
  beforeEach(() => {
    enabled.value = true;
    locks = [];
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    request.mockReset().mockImplementation(async () => {
      const lock = new Lock();
      locks.push(lock);
      return lock;
    });
    vi.stubGlobal("navigator", { wakeLock: { request } });
  });
  afterEach(() => {
    wrapper?.unmount();
    wrapper = undefined;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  async function open() {
    wrapper = mount(
      defineComponent({
        setup() {
          useScreenWakeLock(() => enabled.value);
          return () => null;
        },
      }),
    );
    await flushPromises();
  }
  it("requests only on enabled routes and releases on exit", async () => {
    enabled.value = false;
    await open();
    expect(request).not.toHaveBeenCalled();
    enabled.value = true;
    await flushPromises();
    expect(request).toHaveBeenCalledExactlyOnceWith("screen");
    document.dispatchEvent(new Event("pointerdown"));
    expect(request).toHaveBeenCalledTimes(1);
    enabled.value = false;
    await flushPromises();
    expect(locks[0]!.released).toBe(true);
  });
  it("releases in the background and reacquires when visible", async () => {
    await open();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await flushPromises();
    expect(locks[0]!.released).toBe(true);
    document.dispatchEvent(new Event("pointerdown"));
    expect(request).toHaveBeenCalledTimes(1);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await flushPromises();
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("restores after a page-cache return", async () => {
    await open();
    window.dispatchEvent(new Event("pagehide"));
    await flushPromises();
    expect(locks[0]!.released).toBe(true);
    window.dispatchEvent(new Event("pageshow"));
    await flushPromises();
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("does not loop when the OS rejects or releases a lock, and retries on interaction", async () => {
    request.mockRejectedValueOnce(new DOMException("Power saving", "NotAllowedError"));
    await open();
    expect(request).toHaveBeenCalledTimes(1);
    document.dispatchEvent(new Event("pointerdown"));
    await flushPromises();
    expect(request).toHaveBeenCalledTimes(2);
    await locks[0]!.release();
    await flushPromises();
    expect(request).toHaveBeenCalledTimes(2);
    document.dispatchEvent(new Event("keydown"));
    await flushPromises();
    expect(request).toHaveBeenCalledTimes(3);
  });
  it("releases a late response after leaving the game", async () => {
    let resolve!: (lock: Lock) => void;
    request.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await open();
    enabled.value = false;
    const lock = new Lock();
    resolve(lock);
    await flushPromises();
    expect(lock.released).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("reacquires after leaving and returning while an older request is pending", async () => {
    let resolve!: (lock: Lock) => void;
    request.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await open();
    enabled.value = false;
    enabled.value = true;
    const old = new Lock();
    resolve(old);
    await flushPromises();
    expect(old.released).toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
    expect(locks[0]!.released).toBe(false);
  });
  it("cleans up listeners and any late lock after unmount", async () => {
    let resolve!: (lock: Lock) => void;
    request.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await open();
    wrapper!.unmount();
    wrapper = undefined;
    const lock = new Lock();
    resolve(lock);
    await flushPromises();
    expect(lock.released).toBe(true);
    document.dispatchEvent(new Event("pointerdown"));
    window.dispatchEvent(new Event("pageshow"));
    await flushPromises();
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("leaves unsupported browsers usable", async () => {
    vi.stubGlobal("navigator", {});
    await open();
    document.dispatchEvent(new Event("pointerdown"));
    await flushPromises();
    expect(request).not.toHaveBeenCalled();
  });
});
