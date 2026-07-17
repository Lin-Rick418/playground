import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import vue from "eslint-plugin-vue";
import prettier from "eslint-config-prettier";

const TEST_FILES = [
  "**/*.test.ts",
  "**/*.test.mts",
  "**/*.test.mjs",
  "**/test/**/*.ts",
  "**/tests/**/*.{ts,mjs}",
  "**/fixtures/**/*.ts",
];

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
    ],
  },
  js.configs.recommended,

  // Type-checked rules for the server and shared contracts, where the async
  // discipline (floating promises, misused promises) matters most. Tests and
  // fixtures are excluded from the typed program and linted syntactically
  // below, so they need not be part of a build tsconfig.
  {
    files: ["apps/server/**/*.ts", "packages/contracts/**/*.ts"],
    ignores: TEST_FILES,
    extends: [
      ...tseslint.configs.recommended,
      ...tseslint.configs.recommendedTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
    rules: {
      // Async-safety: the rules this adoption is really for.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      // The codebase uses leading-underscore names for intentionally unused
      // bindings (e.g. _req in Express handlers).
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      // Stringifying values read from `unknown`-typed PostgreSQL rows through an
      // explicit String(...) is an intentional, safe pattern here; the rule
      // cannot see that a text column is never an object.
      "@typescript-eslint/no-base-to-string": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      // Several functions are async to satisfy a shared call signature even when
      // a given implementation has nothing to await; that is deliberate.
      "@typescript-eslint/require-await": "off",
    },
  },

  // The web app is type-checked through vue-tsc; keep ESLint here syntactic to
  // avoid a second, slower type-aware program over .vue single-file components.
  {
    files: ["apps/web/**/*.{ts,vue}"],
    ignores: TEST_FILES,
    extends: [
      ...tseslint.configs.recommended,
      ...vue.configs["flat/recommended"],
    ],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
        extraFileExtensions: [".vue"],
      },
      globals: { ...globals.browser },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
    },
  },

  // Node ESM files: tooling scripts, deploy helpers, and the .mjs test runners
  // all execute under Node.
  {
    files: ["**/*.mjs"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // Test + fixture TypeScript across every workspace: linted syntactically (no
  // typed program) so tests need not belong to a build tsconfig. The node:test
  // runner drives top-level `test(...)` calls whose promise is intentionally
  // not awaited, and tests deliberately throw non-Error values, so type-aware
  // async rules would only be false positives.
  {
    files: ["**/*.test.ts", "**/*.test.mts", "**/test/**/*.ts", "**/tests/**/*.ts", "**/fixtures/**/*.ts"],
    extends: [...tseslint.configs.recommended],
    languageOptions: {
      // Tests span the server (node) and web (browser) runtimes.
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-misused-promises": "off",
      "@typescript-eslint/only-throw-error": "off",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },

  prettier,
);
