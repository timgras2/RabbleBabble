/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

/**
 * Build-mode constants, replaced literally by Vite `define`.
 *
 * They are `define` rather than import.meta.env because define is textual
 * replacement before Rollup: `if (SERVICE_MODE)` becomes `if (true)` and the
 * other branch is deleted outright. That matters because the hosted build must
 * contain no code path that sends audio to Groq with a user-supplied key.
 */
declare const __RB_SERVICE_MODE__: boolean;

/** Worker base URL, or "" when the Worker answers on this same origin. */
declare const __RB_API_BASE_URL__: string;
