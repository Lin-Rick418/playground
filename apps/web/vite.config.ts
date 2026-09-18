import { defineConfig, loadEnv } from "vite";
import vue from "@vitejs/plugin-vue";
import mobile from "postcss-mobile-forever";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const proxyTarget = env.VITE_PROXY_TARGET ?? "http://127.0.0.1:4000";

  return {
    plugins: [
      vue(),
      VitePWA({
        strategies: "injectManifest",
        srcDir: "pwa",
        filename: "sw.js",
        injectRegister: false,
        manifestFilename: "manifest.webmanifest",
        includeManifestIcons: false,
        injectManifest: { globPatterns: ["pwa/offline.{html,css,js}"] },
        // public/manifest.webmanifest is shared by dev tunnels and production.
        // Only Service Worker registration/caching remains production-only.
        manifest: false,
        devOptions: { enabled: false },
      }),
    ],
    css: {
      preprocessorOptions: {
        scss: {
          additionalData: '@use "/src/styles/tokens" as *; @use "/src/styles/mixins" as *;',
        },
      },
      postcss: {
        plugins: [
          mobile({
            appSelector: "#app",
            viewportWidth: 375,
            maxDisplayWidth: 430,
            // Plinko and Hi-Lo are responsive; shared control sizes stay in CSS pixels on every page.
            exclude: /(?:Plinko|Hilo)View\.vue|WinCelebration\.vue|styles\/ui\.css/,
          }),
        ],
      },
    },
    server: {
      host: "0.0.0.0",
      proxy: {
        "/api": {
          target: proxyTarget,
          changeOrigin: true,
          ws: true,
          rewrite: (path) => path.replace(/^\/api/, ""),
        },
      },
    },
    preview: {
      host: "0.0.0.0",
    },
  };
});
