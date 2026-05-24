import fs from "node:fs";
import { injectFile, reverseInject } from "./injector.js";
import { log, errMsg } from "./logger.js";
import { PMD_CONTEXT_SEPARATOR } from "../config.js";
import type { PipeConfig } from "../config.js";

export function loadBase(config: PipeConfig): string {
  if (!config.base) return "";
  try {
    return fs.readFileSync(config.base, "utf-8").trimEnd();
  } catch (err: unknown) { log.debug(`loadBase readFileSync failed: ${errMsg(err)}`); return ""; }
}

export function composeContent(base: string, renderedTemplate: string): string {
  if (!base) return renderedTemplate;
  return base + PMD_CONTEXT_SEPARATOR + renderedTemplate;
}

export function splitContextContent(content: string): { base: string; template: string } {
  const idx = content.indexOf("<!-- pmd-context -->");
  if (idx === -1) {
    return { base: "", template: content };
  }
  const base = content.slice(0, idx).replace(/\n*---\n*$/, "").trimEnd();
  const template = content.slice(idx + "<!-- pmd-context -->".length).trimStart();
  return { base, template };
}

export function handleIncomingWrite(
  data: string,
  templatePath: string,
  config: PipeConfig,
  writeBackInProgress: { value: boolean },
): void {
  if (writeBackInProgress.value) return;
  writeBackInProgress.value = true;
  try {
    const { base: newBase, template: templatePortion } = splitContextContent(data);
    const currentBase = loadBase(config);

    if (newBase && newBase !== currentBase && config.base) {
      try {
        const tmpPath = config.base + ".tmp";
        fs.writeFileSync(tmpPath, newBase + "\n", "utf-8");
        fs.renameSync(tmpPath, config.base);
        log.info("Base instructions updated from AI write-back");
      } catch (baseErr: unknown) {
        const msg = errMsg(baseErr);
        log.error(`Error saving base file: ${msg}`);
      }
    }

    const template = fs.readFileSync(templatePath, "utf-8");
    const contentToDeRender = templatePortion || data;
    const deRendered = reverseInject(contentToDeRender, template);
    if (deRendered !== template) {
      const tmpPath = templatePath + ".tmp";
      try {
        fs.writeFileSync(tmpPath, deRendered, "utf-8");
        fs.renameSync(tmpPath, templatePath);
      } catch (writeErr) {
        try { fs.unlinkSync(tmpPath); } catch (err: unknown) { log.debug(`unlink tmpPath failed: ${errMsg(err)}`); }
        throw writeErr;
      }
      log.info("De-rendered AI write-back → template.md updated");
      const changed = injectFile(templatePath, config);
      if (changed) {
        log.info("Re-injected template after write-back");
      }
    }
  } catch (err: unknown) {
    const msg = errMsg(err);
    log.error(`Error processing AI write-back: ${msg}`);
  } finally {
    writeBackInProgress.value = false;
  }
}
