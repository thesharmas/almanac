import js from "@eslint/js";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

export default [
  {
    ignores: ["node_modules/**", "dist/**", "generated/**", "coverage/**"],
  },
  js.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
      ecmaVersion: 2023,
      sourceType: "module",
    },
    plugins: { "@typescript-eslint": tsPlugin },
    rules: {
      ...tsPlugin.configs["recommended-type-checked"].rules,

      // TypeScript resolves identifiers itself and knows the Node lib globals
      // (fetch, Response, AbortSignal, process). Leaving no-undef on for .ts
      // files only produces false positives for those.
      "no-undef": "off",

      // The tenancy model depends on never silently coercing an absent agent
      // id or tenant into a usable value. These keep that honest.
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/no-unnecessary-condition": "error",
      "@typescript-eslint/strict-boolean-expressions": [
        "error",
        { allowNullableBoolean: false, allowNullableString: false },
      ],

      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-console": ["error", { allow: ["warn", "error"] }],
      eqeqeq: ["error", "always"],
    },
  },
  {
    files: ["*.config.ts", "*.config.js"],
    rules: {
      "@typescript-eslint/no-unnecessary-condition": "off",
    },
  },
  {
    // Plain Node scripts under infra/. They are not part of the TypeScript
    // program, so the parser cannot resolve `process` and `console` for them
    // the way it does for .ts files.
    files: ["infra/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { process: "readonly", console: "readonly" },
    },
    rules: {
      "no-console": "off",
    },
  },
];
