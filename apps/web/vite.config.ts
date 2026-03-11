import { defineConfig, loadEnv } from "vite";
import vue from "@vitejs/plugin-vue";
import mobile from "postcss-mobile-forever";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const proxyTarget = env.VITE_PROXY_TARGET ?? "http://127.0.0.1:4000";

  return {
    plugins: [vue()],
    css: {
      postcss: {
        plugins: [
          mobile({
            appSelector: "#app",
            viewportWidth: 390,
            maxDisplayWidth: 430,
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
