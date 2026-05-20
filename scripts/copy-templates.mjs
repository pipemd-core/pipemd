import { mkdirSync, readdirSync, copyFileSync } from "node:fs";
mkdirSync("dist/templates", { recursive: true });
for (const f of readdirSync("templates")) {
  if (f.endsWith(".md")) copyFileSync(`templates/${f}`, `dist/templates/${f}`);
}
