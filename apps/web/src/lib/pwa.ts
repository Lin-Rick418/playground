import { reactive, readonly } from "vue";

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const state = reactive({
  installed: false,
  canInstall: false,
  installing: false,
  offline: false,
});
export const pwaState = readonly(state);
let pendingPrompt: InstallPromptEvent | null = null;

export function initializePwa() {
  const display = window.matchMedia("(display-mode: standalone)");
  const iosNavigator = navigator as Navigator & { standalone?: boolean };
  const updateDisplay = () => {
    state.installed = display.matches || iosNavigator.standalone === true;
  };
  const updateNetwork = () => {
    state.offline = !navigator.onLine;
  };
  updateDisplay();
  updateNetwork();
  const beforeInstall = (event: Event) => {
    event.preventDefault();
    pendingPrompt = event as InstallPromptEvent;
    state.canInstall = true;
  };
  const installed = () => {
    state.installed = true;
    state.canInstall = false;
    pendingPrompt = null;
  };
  window.addEventListener("beforeinstallprompt", beforeInstall);
  window.addEventListener("appinstalled", installed);
  window.addEventListener("online", updateNetwork);
  window.addEventListener("offline", updateNetwork);
  display.addEventListener("change", updateDisplay);

  if (import.meta.env.PROD && "serviceWorker" in navigator) {
    void navigator.serviceWorker
      .register("/sw.js", { scope: "/", updateViaCache: "none" })
      .catch((error: unknown) =>
        console.warn("Casino offline support could not be registered", error),
      );
  }
  return () => {
    window.removeEventListener("beforeinstallprompt", beforeInstall);
    window.removeEventListener("appinstalled", installed);
    window.removeEventListener("online", updateNetwork);
    window.removeEventListener("offline", updateNetwork);
    display.removeEventListener("change", updateDisplay);
    pendingPrompt = null;
    state.canInstall = false;
  };
}

export async function installPwa() {
  const prompt = pendingPrompt;
  if (!prompt || state.installing) return;
  pendingPrompt = null;
  state.canInstall = false;
  state.installing = true;
  try {
    await prompt.prompt();
    await prompt.userChoice;
  } catch {
    // The browser may invalidate a prompt; wait for a fresh install event.
  } finally {
    state.installing = false;
  }
}
