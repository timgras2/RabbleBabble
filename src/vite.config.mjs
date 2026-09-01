import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { VitePWA } from "vite-plugin-pwa";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  plugins: [
    react(),
    basicSsl(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: false,
      workbox: {
        globPatterns: ["**/*.{js,css,html,png,svg,ico}"],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/api\.groq\.com\//,
            handler: "NetworkOnly",
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
});
