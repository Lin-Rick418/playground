import { onBeforeUnmount, onMounted, type Ref } from "vue";

/** Keep the login scroller inside the area above the mobile keyboard. */
export function useLoginViewport(container: Ref<HTMLElement | null>) {
  let viewport: VisualViewport | null = null;
  let frame = 0;

  function sync() {
    frame = 0;
    const element = container.value;
    if (!element) return;
    // dvh follows browser chrome, but does not reliably shrink for the iOS keyboard.
    element.style.height = `${viewport?.height ?? window.innerHeight}px`;
    element.style.top = `${viewport?.offsetTop ?? 0}px`;

    const active = document.activeElement;
    if (!(active instanceof HTMLInputElement) || !element.contains(active)) return;
    const bounds = element.getBoundingClientRect();
    const field = active.getBoundingClientRect();
    const padding = 16;
    if (field.bottom > bounds.bottom - padding) {
      element.scrollTop += field.bottom - bounds.bottom + padding;
    } else if (field.top < bounds.top + padding) {
      element.scrollTop -= bounds.top + padding - field.top;
    }
  }

  function schedule() {
    if (!frame) frame = requestAnimationFrame(sync);
  }

  onMounted(() => {
    viewport = window.visualViewport;
    viewport?.addEventListener("resize", schedule);
    viewport?.addEventListener("scroll", schedule);
    window.addEventListener("resize", schedule);
    window.addEventListener("pageshow", schedule);
    container.value?.addEventListener("focusin", schedule);
    sync();
  });

  onBeforeUnmount(() => {
    cancelAnimationFrame(frame);
    viewport?.removeEventListener("resize", schedule);
    viewport?.removeEventListener("scroll", schedule);
    window.removeEventListener("resize", schedule);
    window.removeEventListener("pageshow", schedule);
    container.value?.removeEventListener("focusin", schedule);
  });
}
