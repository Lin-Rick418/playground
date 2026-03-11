import { defineConfig, loadEnv } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const proxyTarget = env.VITE_PROXY_TARGET ?? "http://127.0.0.1:4000";

  return {
    plugins: [vue()],
    server: {
      host: "0.0.0.0",
      proxy: {
        "/api": {
          target: proxyTarget,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ""),
        },
      },
    },
    preview: {
      host: "0.0.0.0",
    },
  };
});
