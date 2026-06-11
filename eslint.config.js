import tseslint from "typescript-eslint";
import js from "@eslint/js";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-empty": "off",
      "no-control-regex": "off",
    },
  },
  {
    ignores: ["dist/", "tests/", "scripts/", "*.mjs", "src/plugins/", ".pipemd/", ".opencode/"],
  },
  {
    files: ["tsup.config.ts"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
);
