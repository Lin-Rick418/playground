import {
  computed,
  inject,
  onMounted,
  onUnmounted,
  provide,
  ref,
  type InjectionKey,
  type Ref,
} from "vue";

export const portraitBlockedKey: InjectionKey<Readonly<Ref<boolean>>> = Symbol("portraitBlocked");

export function usePortraitBlocked() {
  return inject(portraitBlockedKey, ref(false));
}

function isMobileDevice() {
  const ua = navigator.userAgent;
  const mobileHint = (navigator as Navigator & { userAgentData?: { mobile?: boolean } })
    .userAgentData;
  return (
    mobileHint?.mobile === true ||
    /Android|iPhone|iPad|iPod/i.test(ua) ||
    (/Macintosh|MacIntel/i.test(`${ua} ${navigator.platform}`) && navigator.maxTouchPoints > 1)
  );
}

function isLandscape() {
  // Physical orientation does not change when the portrait soft keyboard opens.
  const type = window.screen.orientation?.type;
  if (type?.startsWith("landscape")) return true;
  if (type?.startsWith("portrait")) return false;
  const legacyAngle = (window as Window & { orientation?: number }).orientation;
  if (typeof legacyAngle === "number") return Math.abs(legacyAngle) % 180 === 90;
  // Older webviews without either orientation API still expose screen dimensions.
  return window.screen.width > window.screen.height;
}

export function providePortraitGuard(enabled: () => boolean) {
  const landscape = ref(isMobileDevice() && isLandscape());
  const blocked = computed(() => enabled() && landscape.value);
  provide(portraitBlockedKey, blocked);
  const update = () => {
    landscape.value = isMobileDevice() && isLandscape();
  };
  onMounted(() => {
    update();
    window.screen.orientation?.addEventListener("change", update);
    window.addEventListener("orientationchange", update);
    window.addEventListener("resize", update);
    window.addEventListener("pageshow", update);
  });
  onUnmounted(() => {
    window.screen.orientation?.removeEventListener("change", update);
    window.removeEventListener("orientationchange", update);
    window.removeEventListener("resize", update);
    window.removeEventListener("pageshow", update);
  });
  return blocked;
}
