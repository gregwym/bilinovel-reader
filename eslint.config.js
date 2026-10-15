import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "dist-app/", "node_modules/", "site/", "_site/", "tests/fixtures/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        window: "readonly",
        document: "readonly",
        console: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "no-console": "off",
    },
  },
  {
    files: ["app/web/public/sw.js"],
    languageOptions: {
      globals: { self: "readonly", caches: "readonly", location: "readonly", fetch: "readonly", URL: "readonly", Response: "readonly" },
    },
  },
  {
    files: ["scripts/**", "vite.config.ts"],
    languageOptions: { globals: { process: "readonly" } },
  },
);
