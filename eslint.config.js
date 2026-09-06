import eslint from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist", "node_modules", "coverage", ".wrangler", "worker/worker-configuration.d.ts"],
  },
  eslint.configs.recommended,
  // Type-aware, not just syntactic. `recommended` leaves no-floating-promises
  // and no-misused-promises switched off, in a codebase full of
  // AbortControllers, wake locks, IndexedDB requests and D1 calls -- exactly
  // where an unawaited promise goes unnoticed.
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
      // Explicit projects rather than projectService: the repo deliberately
      // has two tsconfigs with different libs and globals, and each file
      // belongs to exactly one of them.
      parserOptions: {
        project: ["./tsconfig.json", "./tsconfig.worker.json", "./tsconfig.e2e.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Off deliberately. The point of turning on type-aware linting was
      // no-floating-promises and no-misused-promises; require-await flags
      // every `async () => value` port implementation and test double, all of
      // which are correct -- an async signature is part of the contract there.
      "@typescript-eslint/require-await": "off",
    },
  },
  {
    // Tests speak to untyped JSON and to mock call records, where `any` is the
    // honest type. The rules that matter for correctness stay on everywhere.
    files: ["**/*.test.{ts,tsx}", "src/test/**/*.ts", "worker/test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-base-to-string": "off",
      "@typescript-eslint/unbound-method": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
    },
  },
  {
    // Plain JavaScript, so there is no type information to check against.
    files: ["**/*.{js,mjs}"],
    extends: [tseslint.configs.disableTypeChecked],
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
  {
    files: ["worker/**/*.ts"],
    languageOptions: {
      globals: {
        ...globals.worker,
        ...globals.node,
      },
    },
    rules: {
      // The Worker shares src/shared and nothing else. Reaching into the
      // browser adapters would drag DOM assumptions into workerd.
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/platform/**", "**/ui/**", "**/services/**", "**/app/**"],
              message: "The Worker may only import from src/shared.",
            },
          ],
        },
      ],
    },
  },
);
