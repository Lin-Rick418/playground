// Isolated production builds and Vite preview; no database or real API needed.
import { build, preview } from "vite";
import { mkdtemp, cp, appendFile, symlink, unlink, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
const root = path.resolve("apps/web");
const temp = await mkdtemp(path.join(tmpdir(), "casino-pwa-"));
const current = path.join(temp, "current");
for (const version of ["a", "b"]) {
  const publicDir = path.join(temp, `public-${version}`);
  await cp(path.join(root, "public"), publicDir, { recursive: true });
  await appendFile(path.join(publicDir, "pwa/offline.html"), `\n<!-- release ${version} -->\n`);
  await build({ root, publicDir, build: { outDir: path.join(temp, version), emptyOutDir: true } });
}
await symlink(path.join(temp, "a"), current);
const csp =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'self'";
const server = await preview({
  configFile: false,
  root,
  build: { outDir: current },
  preview: { host: "127.0.0.1", port: 4175, strictPort: true },
  plugins: [
    {
      name: "pwa-test-server",
      configurePreviewServer(server) {
        server.middlewares.use(async (req, res, next) => {
          const pathname = new URL(req.url, "http://localhost").pathname;
          res.setHeader("Cache-Control", "no-cache");
          res.setHeader("Content-Security-Policy", csp);
          if (pathname === "/__test__/version" && req.method === "POST") {
            const version = new URL(req.url, "http://localhost").searchParams.get("v");
            if (version !== "a" && version !== "b") {
              res.statusCode = 400;
              res.end();
              return;
            }
            await unlink(current);
            await symlink(path.join(temp, version), current);
            res.end(version);
            return;
          }
          if (pathname.startsWith("/api/")) {
            res.setHeader("Content-Type", "application/json");
            res.statusCode = pathname === "/api/pwa-probe" ? 200 : 401;
            res.end(JSON.stringify({ message: "test-only", balance: 12345 }));
            return;
          }
          if (pathname === "/__test__/http-error") {
            res.statusCode = 503;
            res.end("Maintenance");
            return;
          }
          // Mirror the deployment's strict PWA resource routes (never SPA fallbacks).
          const pwaType =
            pathname === "/sw.js"
              ? "application/javascript"
              : pathname === "/manifest.webmanifest"
                ? "application/manifest+json"
                : pathname.startsWith("/pwa/") || pathname.startsWith("/icons/")
                  ? {
                      ".html": "text/html",
                      ".css": "text/css",
                      ".js": "application/javascript",
                      ".png": "image/png",
                      ".svg": "image/svg+xml",
                    }[path.extname(pathname)] || "application/octet-stream"
                  : null;
          if (pwaType) {
            try {
              res.setHeader("Content-Type", pwaType);
              res.end(await readFile(path.join(current, pathname)));
            } catch {
              res.statusCode = 404;
              res.end("Not found");
            }
            return;
          }
          next();
        });
      },
    },
  ],
});
const close = async () => {
  server.httpServer.close();
  await rm(temp, { recursive: true, force: true });
  process.exit(0);
};
process.on("SIGTERM", close);
process.on("SIGINT", close);
