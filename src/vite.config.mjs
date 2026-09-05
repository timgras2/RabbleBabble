import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { VitePWA } from "vite-plugin-pwa";
import { defineConfig } from "vite";

const CONTENT_SECURITY_POLICY = "default-src 'self'; script-src 'self'; connect-src 'self' https://api.groq.com; img-src 'self' data:; style-src 'self'; font-src 'self'; manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'self'";

export default defineConfig(({ command }) => ({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  plugins: [
    react(),
    basicSsl(),
    {
      name: "production-content-security-policy",
      transformIndexHtml(html) {
        if (command !== "build") {
          return html;
        }
        return {
          html,
          tags: [
            {
              tag: "meta",
              attrs: {
                "http-equiv": "Content-Security-Policy",
                content: CONTENT_SECURITY_POLICY,
              },
              injectTo: "head",
            },
          ],
        };
      },
    },
    VitePWA({
      registerType: "autoUpdate",
      manifest: false,
      workbox: {
        globPatterns: ["**/*.{js,css,html,png,svg,ico}"],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/api\.groq\.com\//,
            handler: "NetworkOnly",
            // This entry matches GET requests; the explicit POST route follows because Workbox defaults to GET.
          },
          {
            urlPattern: /^https:\/\/api\.groq\.com\//,
            handler: "NetworkOnly",
            method: "POST",
          },
        ],
      },
    }),
  ],
  server: {
    host: true,
    port: 5174,
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
}));
