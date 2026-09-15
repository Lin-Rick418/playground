import { afterEach, beforeEach, expect, it } from "vitest";
import { installZoomLock } from "./zoom-lock";

let remove: () => void;
beforeEach(() => {
  remove = installZoomLock();
});
afterEach(() => remove());

function cancelled(event: Event) {
  document.dispatchEvent(event);
  return event.defaultPrevented;
}

it("blocks double-click and Safari pinch zoom without blocking single clicks", () => {
  for (const type of ["dblclick", "gesturestart", "gesturechange"]) {
    expect(cancelled(new Event(type, { cancelable: true }))).toBe(true);
  }
  expect(cancelled(new MouseEvent("click", { cancelable: true }))).toBe(false);
});

it("blocks multiple-finger gestures while preserving one-finger scrolling", () => {
  for (const type of ["touchstart", "touchmove"]) {
    for (const fingers of [1, 2]) {
      const event = new Event(type, { cancelable: true });
      Object.defineProperty(event, "touches", { value: Array(fingers).fill({}) });
      expect(cancelled(event)).toBe(fingers > 1);
    }
  }
});

it("blocks zoom shortcuts and modified wheel but preserves typing, copy and normal scrolling", () => {
  for (const modifier of ["ctrlKey", "metaKey"]) {
    for (const key of ["+", "=", "-", "_", "0"]) {
      expect(
        cancelled(new KeyboardEvent("keydown", { key, [modifier]: true, cancelable: true })),
      ).toBe(true);
    }
    expect(
      cancelled(new KeyboardEvent("keydown", { key: "c", [modifier]: true, cancelable: true })),
    ).toBe(false);
    const wheel = new WheelEvent("wheel", { cancelable: true });
    // happy-dom's WheelEvent constructor does not initialize keyboard modifiers.
    Object.defineProperty(wheel, modifier, { value: true });
    expect(cancelled(wheel)).toBe(true);
  }
  expect(cancelled(new KeyboardEvent("keydown", { key: "0", cancelable: true }))).toBe(false);
  expect(cancelled(new WheelEvent("wheel", { cancelable: true }))).toBe(false);
});

it("removes the listeners when disposed", () => {
  remove();
  expect(cancelled(new Event("gesturestart", { cancelable: true }))).toBe(false);
});
