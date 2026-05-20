import { mkdirSync, copyFileSync } from "node:fs";
mkdirSync("dist/plugins", { recursive: true });
copyFileSync("src/plugins/opencode-server.js", "dist/plugins/opencode-server.js");
copyFileSync("src/plugins/opencode-tui.js", "dist/plugins/opencode-tui.js");
