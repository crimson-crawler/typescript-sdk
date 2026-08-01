// ESLint flat config (eslint.config.js) — TypeScript wrapper layer.
//
// Mirrors the lint coverage the Python wrapper gets from ruff. TypeScript's
// generated code (src/_generated/) is gitignored build output, unlike Python's
// tracked generated layer, and is excluded here.
//
// Type-aware rules (no-floating-promises, no-misused-promises, etc.) are the
// real value-add over plain `tsc --strict` — they catch a class of async bugs
// `tsc` can't see (forgotten `await`, promise-as-cleanup-callback, etc.).

import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  // 1. Globally ignore generated + build output.
  {
    ignores: ["src/_generated/**", "dist/**", "coverage/**", "node_modules/**"],
  },

  // 2. Hand-written wrapper layer + tests — full type-aware checks.
  // Uses typescript-eslint v8's projectService for auto-tsconfig resolution
  // (handles src/ and tests/ both, even though tests/ isn't in the publish
  // tsconfig — ESLint just needs *some* tsconfig that covers each file).
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    // Use `recommended` not `recommendedTypeChecked` — the type-checked preset
    // flags every `.body` / `.foo` access on the generated layer (which types
    // as `any` because openapi-python-client / @hey-api expose JSON-shaped
    // anys). The wrapper unavoidably interacts with that surface; turning
    // those rules on would generate a wall of `no-unsafe-*` noise on every
    // legitimate interaction. We still get the type-aware rules we actually
    // want (no-floating-promises, no-misused-promises, no-unnecessary-type-
    // assertion) by enabling them explicitly under `rules` below.
    extends: [eslint.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.node,
      },
      parserOptions: {
        // Use tsconfig.test.json which extends tsconfig.json and adds tests/.
        // The publish tsconfig (tsconfig.json) restricts rootDir to src/ for
        // tsup; ESLint needs a tsconfig that covers test files too.
        project: "./tsconfig.test.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Project conventions — matches what ruff catches on the Python side.
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-explicit-any": "warn",
      // Generated code uses `any` heavily; the wrapper layer should not.
    },
  },

  // 3. Config files (openapi-ts.config.ts, tsup.config.ts, vitest.config.ts,
  // eslint.config.js) — type-aware checks not needed; just basic JS hygiene.
  // Need globals.node for things like `process.env`.
  {
    files: ["*.config.{js,mjs,ts}", "*.config.*.{js,mjs,ts}"],
    extends: [eslint.configs.recommended],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
);
