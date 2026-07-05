import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let _version: string | null = null;

/**
 * Returns the PipeMD package version. Works in both production (tsup build)
 * and dev/test (tsx) by walking up from this module to find package.json.
 */
export function getPmdVersion(): string {
  if (_version !== null) return _version;
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    let dir = here;
    for (let i = 0; i < 6; i++) {
      const pkgPath = path.join(dir, "package.json");
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
        if (pkg.name === "@pipemd-core/pipemd") {
          _version = String(pkg.version || "unknown");
          return _version;
        }
      } catch {}
      dir = path.dirname(dir);
    }
  } catch {}
  _version = "unknown";
  return _version;
}
