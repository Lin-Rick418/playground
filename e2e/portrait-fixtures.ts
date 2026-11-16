import type { Page } from "@playwright/test";

// Desktop browser projects need mobile hardware signals for orientation tests.
// Mock the browser API boundary, never the application guard state.
export async function emulateMobileOrientation(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "userAgent", {
      get: () => "Mozilla/5.0 (iPhone) Mobile",
      configurable: true,
    });
    const orientation = new EventTarget();
    Object.defineProperty(orientation, "type", {
      get: () => (innerWidth > innerHeight ? "landscape-primary" : "portrait-primary"),
    });
    Object.defineProperty(screen, "orientation", { value: orientation, configurable: true });
  });
}
