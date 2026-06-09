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
    files: [".opencode/**/*.js"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        require: "readonly",
        fetch: "readonly",
        AbortSignal: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        module: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-require-imports": "off",
      "no-empty": "off",
      "no-undef": "off",
    },
  },
  {
    ignores: ["dist/", "tests/", "scripts/", "*.mjs", "src/plugins/"],
  },
);
