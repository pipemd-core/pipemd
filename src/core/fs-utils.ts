import { openSync, closeSync, writeSync, renameSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";

export function atomicWrite(filePath: string, data: string, encoding: BufferEncoding = "utf-8"): void {
  const tmp = filePath + `.tmp-${randomBytes(16).toString("hex")}`;
  const fd = openSync(tmp, "wx");
  try {
    writeSync(fd, data, 0, encoding);
    closeSync(fd);
    renameSync(tmp, filePath);
  } catch {
    try { closeSync(fd); } catch {}
    try { unlinkSync(tmp); } catch {}
    throw new Error(`atomicWrite failed for ${filePath}`);
  }
}
