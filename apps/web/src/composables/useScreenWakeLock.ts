import { onUnmounted, watch } from "vue";

/** Keep visible game screens awake; respect system release and power-saving decisions. */
export function useScreenWakeLock(enabled: () => boolean) {
  let sentinel: WakeLockSentinel | null = null;
  let pending = false;
  let disposed = false;
  let pageActive = true;
  let revision = 0;
  const wanted = () =>
    !disposed && pageActive && enabled() && document.visibilityState === "visible";
  async function release(lock: WakeLockSentinel | null) {
    try {
      await lock?.release();
    } catch {
      /* Already released or document is inactive. */
    }
  }
  async function acquire() {
    if (!wanted() || pending || sentinel || !navigator.wakeLock?.request) return;
    const requestRevision = revision;
    pending = true;
    try {
      const lock = await navigator.wakeLock.request("screen");
      if (!wanted() || revision !== requestRevision) {
        await release(lock);
        return;
      }
      if (lock.released) return;
      sentinel = lock;
      lock.addEventListener(
        "release",
        () => {
          if (sentinel === lock) sentinel = null;
          // Retry only on return or interaction, not in a loop against a system rejection.
        },
        { once: true },
      );
    } catch {
      // Unsupported contexts, low battery and OS policy must not interrupt gameplay.
    } finally {
      pending = false;
      if (wanted() && revision !== requestRevision) void acquire();
    }
  }
  function sync() {
    revision++;
    if (wanted()) void acquire();
    else {
      const previous = sentinel;
      sentinel = null;
      void release(previous);
    }
  }
  function pageHide() {
    pageActive = false;
    sync();
  }
  function pageShow() {
    pageActive = true;
    sync();
  }
  const retry = () => void acquire();
  document.addEventListener("visibilitychange", sync);
  document.addEventListener("pointerdown", retry, { passive: true });
  document.addEventListener("keydown", retry);
  window.addEventListener("pagehide", pageHide);
  window.addEventListener("pageshow", pageShow);
  const stop = watch(enabled, sync, { immediate: true, flush: "sync" });
  onUnmounted(() => {
    disposed = true;
    stop();
    sync();
    document.removeEventListener("visibilitychange", sync);
    document.removeEventListener("pointerdown", retry);
    document.removeEventListener("keydown", retry);
    window.removeEventListener("pagehide", pageHide);
    window.removeEventListener("pageshow", pageShow);
  });
}
