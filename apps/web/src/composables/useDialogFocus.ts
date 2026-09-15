import { nextTick, onBeforeUnmount, watch, type Ref } from "vue";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

type DialogFocusOptions = {
  isOpen: () => boolean;
  dialogRef: Ref<HTMLElement | null>;
  close: () => void;
  initialFocusRef?: Ref<Pick<HTMLElement, "focus"> | null>;
};

function getFocusableElements(dialog: HTMLElement) {
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => !element.hidden && element.getAttribute("aria-hidden") !== "true",
  );
}

export function useDialogFocus(options: DialogFocusOptions) {
  let previouslyFocused: HTMLElement | null = null;

  function onDialogKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      options.close();
      return;
    }

    if (event.key !== "Tab" || !options.dialogRef.value) {
      return;
    }

    const dialog = options.dialogRef.value;
    const focusableElements = getFocusableElements(dialog);

    if (!focusableElements.length) {
      event.preventDefault();
      dialog.focus();
      return;
    }

    const firstElement = focusableElements[0]!;
    const lastElement = focusableElements[focusableElements.length - 1]!;
    const activeElement = document.activeElement;

    if (event.shiftKey && (activeElement === firstElement || !dialog.contains(activeElement))) {
      event.preventDefault();
      lastElement.focus();
      return;
    }

    if (!event.shiftKey && (activeElement === lastElement || !dialog.contains(activeElement))) {
      event.preventDefault();
      firstElement.focus();
    }
  }

  watch(options.isOpen, async (isOpen) => {
    if (isOpen) {
      previouslyFocused =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      await nextTick();

      const dialog = options.dialogRef.value;
      const initialFocus =
        options.initialFocusRef?.value ?? (dialog ? getFocusableElements(dialog)[0] : null);
      (initialFocus ?? dialog)?.focus();
      return;
    }

    if (previouslyFocused) {
      await nextTick();
      previouslyFocused.focus();
      previouslyFocused = null;
    }
  });

  onBeforeUnmount(() => {
    previouslyFocused?.focus();
  });

  return { onDialogKeydown };
}
