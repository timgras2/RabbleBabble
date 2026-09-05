import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { VitePWA } from "vite-plugin-pwa";
import { defineConfig, loadEnv } from "vite";

const APP_ROOT = fileURLToPath(new URL(".", import.meta.url));
// Env files sit beside package.json rather than inside the Vite root, so no
// configuration can accidentally end up served from src/public/.
const ENV_DIR = fileURLToPath(new URL("..", import.meta.url));

const GROQ_ORIGIN = "https://api.groq.com";
const BACKSLASH = String.fromCharCode(92);

function escapeRegExp(value) {
  return value.replace(/[^A-Za-z0-9_-]/g, (character) => BACKSLASH + character);
}

function stripTrailingSlashes(value) {
  let result = value;
  while (result.endsWith("/")) {
    result = result.slice(0, -1);
  }
  return result;
}

/**
 * Service builds talk only to their own origin, so their policy is strictly
 * tighter than the bring-your-own-key build's: no third-party connect-src at all.
 */
function contentSecurityPolicy({ serviceMode, apiOrigin }) {
  const connectSrc = ["'self'"];
  if (serviceMode) {
    // Empty apiOrigin means the Worker answers on this origin, which 'self' covers.
    if (apiOrigin) {
      connectSrc.push(apiOrigin);
    }
  } else {
    connectSrc.push(GROQ_ORIGIN);
  }

  return [
    "default-src 'self'",
    "script-src 'self'",
    `connect-src ${connectSrc.join(" ")}`,
    "img-src 'self' data:",
    "style-src 'self'",
    "font-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}

/**
 * Audio, transcripts and auth responses must never touch Cache Storage.
 * Workbox routes default to GET, so each pattern needs an explicit POST twin.
 */
function networkOnlyPatterns({ serviceMode, apiBaseUrl }) {
  if (!serviceMode) {
    return [new RegExp("^https://api[.]groq[.]com/")];
  }
  return [
    apiBaseUrl
      ? new RegExp(`^${escapeRegExp(apiBaseUrl)}/`)
      // Same-origin API. Workbox only requires a from-index-0 match for
      // cross-origin URLs, so a path pattern is right here.
      : new RegExp("/(v1|auth)/"),
  ];
}

export default defineConfig(({ command, mode }) => {
  if (mode !== "service" && mode !== "byok") {
    throw new Error(
      `RabbleBabble builds for one mode at a time. Pass --mode service or --mode byok (received "${mode}").`,
    );
  }

  const serviceMode = mode === "service";
  const env = loadEnv(mode, ENV_DIR, "VITE_RB_");
  // Empty is the good case: the Worker serves the app and the API from one
  // origin, which is the only shape where the session cookie stays first-party.
  const apiBaseUrl = serviceMode ? stripTrailingSlashes(env.VITE_RB_API_BASE_URL ?? "") : "";
  const apiOrigin = apiBaseUrl.startsWith("http") ? new URL(apiBaseUrl).origin : "";

  const csp = contentSecurityPolicy({ serviceMode, apiOrigin });
  const networkOnly = networkOnlyPatterns({ serviceMode, apiBaseUrl });

  return {
    root: APP_ROOT,
    envDir: ENV_DIR,
    // The Worker serves the service build from the root; GitHub Pages serves
    // the bring-your-own-key build from a /RabbleBabble/ subpath.
    base: serviceMode ? "/" : "./",
    define: {
      __RB_SERVICE_MODE__: JSON.stringify(serviceMode),
      __RB_API_BASE_URL__: JSON.stringify(apiBaseUrl),
    },
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
                  content: csp,
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
          // Without this the service worker answers /auth/callback with the app
          // shell, the Worker never sees the request, and the Set-Cookie that
          // signs the user in never happens.
          navigateFallbackDenylist: serviceMode
            ? [new RegExp("^/v1/"), new RegExp("^/auth/")]
            : [],
          runtimeCaching: networkOnly.flatMap((urlPattern) => [
            { urlPattern, handler: "NetworkOnly" },
            { urlPattern, handler: "NetworkOnly", method: "POST" },
          ]),
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
  };
});
