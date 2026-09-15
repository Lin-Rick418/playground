// Safari may ignore viewport scale limits, so also cancel page-level zoom gestures.
export function installZoomLock(target: Document = document) {
  const controller = new AbortController();
  const options = { capture: true, passive: false, signal: controller.signal };
  const prevent = (event: Event) => event.preventDefault();
  const preventPinch = (event: TouchEvent) => {
    if (event.touches.length > 1) event.preventDefault();
  };

  target.addEventListener("dblclick", prevent, options);
  target.addEventListener("gesturestart", prevent, options);
  target.addEventListener("gesturechange", prevent, options);
  target.addEventListener("touchstart", preventPinch, options);
  target.addEventListener("touchmove", preventPinch, options);
  target.addEventListener(
    "wheel",
    (event) => {
      if (event.ctrlKey || event.metaKey) event.preventDefault();
    },
    options,
  );
  target.addEventListener(
    "keydown",
    (event) => {
      if ((event.ctrlKey || event.metaKey) && ["+", "=", "-", "_", "0"].includes(event.key)) {
        event.preventDefault();
      }
    },
    options,
  );

  return () => controller.abort();
}
