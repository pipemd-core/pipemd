import { Command } from "commander";
import { execFile } from "node:child_process";
import { resolve, extname } from "node:path";
import { isPipemdProject } from "../core/crew.js";

const VALIDATE_TIMEOUT_MS = 4000;

const ESLINT_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx"]);

export const validateCommand = new Command("validate")
  .description("Run eslint on a single file and print results")
  .option("--file <path>", "File to validate")
  .action((opts: { file?: string }) => {
    if (!isPipemdProject()) {
      process.stderr.write("PipeMD not initialized. Run `pmd init` first.\n");
      process.exit(1);
    }

    if (!opts.file) {
      process.stdout.write("ok\n");
      return;
    }

    const filePath = resolve(opts.file);
    const ext = extname(filePath);

    if (!ESLINT_EXTENSIONS.has(ext)) {
      process.stdout.write("ok\n");
      return;
    }

    execFile(
      "npx",
      ["eslint", filePath, "--no-color"],
      { timeout: VALIDATE_TIMEOUT_MS },
      (err, stdout) => {
        if (err && stdout && typeof stdout === "string") {
          const out = stdout.trim();
          if (out) {
            const lines = out.split("\n").slice(0, 5).join("\n");
            process.stdout.write(lines + "\n");
            return;
          }
        }
        process.stdout.write("ok\n");
      },
    );
  });
