import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const authoredJavaScript = [
  "electron/**/*.{cjs,mjs,js}",
  "scripts/**/*.{mjs,cjs,js}",
  "tests/**/*.mjs",
  "parity/scripts/**/*.mjs",
];

export default [
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      ".electron-app/**",
      "release/**",
      "coverage/**",
      "test-results/**",
      "public/vendor/**",
      "models/**",
      "parity/.probe/**",
    ],
  },
  {
    files: authoredJavaScript,
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.node,
    },
    rules: {
      ...js.configs.recommended.rules,
      "no-empty": ["error", { "allowEmptyCatch": true }],
      "no-unused-vars": "off",
      "no-useless-assignment": "off",
      "preserve-caught-error": "off",
    },
  },
  ...tseslint.configs.recommended.map((config) => ({ ...config, files: ["src/**/*.ts"] })),
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "prefer-const": "off",
    },
  },
];
