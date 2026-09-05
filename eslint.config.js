import eslint from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist", "node_modules", "coverage"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    // src/shared is imported by both the browser bundle and the Worker, so it
    // must not reach for anything that only exists on one side. Keeping it to
    // types, constants and pure functions is what lets each tsconfig stay
    // ignorant of the other's globals.
    files: ["src/shared/**/*.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        { name: "window", message: "src/shared must run in the Worker too." },
        { name: "document", message: "src/shared must run in the Worker too." },
        { name: "navigator", message: "src/shared must run in the Worker too." },
        { name: "localStorage", message: "src/shared must run in the Worker too." },
        { name: "fetch", message: "src/shared must stay free of I/O." },
        { name: "Blob", message: "src/shared must stay free of platform types." },
        { name: "FormData", message: "src/shared must stay free of platform types." },
        { name: "caches", message: "src/shared must stay free of platform types." },
      ],
    },
  },
);
