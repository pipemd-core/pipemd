import { writeFileSync, renameSync } from "node:fs";
import { randomBytes } from "node:crypto";

export function atomicWrite(filePath: string, data: string, encoding: BufferEncoding = "utf-8"): void {
  const tmp = filePath + `.tmp-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, data, encoding);
  renameSync(tmp, filePath);
}
