import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import chokidar from "chokidar";
import { injectFile } from "./injector.js";
import { loadBase, composeContent, handleIncomingWrite } from "./daemon-write-back.js";
import { log } from "./logger.js";
import { trackedSetTimeout, trackedClearTimeout } from "./pipe-manager.js";
import type { PipeConfig } from "../config.js";

export function startLegacyWatcher(config: PipeConfig, writeBackGuard: { value: boolean }) {
  log.info("Running in Legacy Mode — files will be modified on disk");
  log.info("git may detect changes in output files");

  const watchedFiles = config.injected
    .filter((i) => i.watch)
    .map((i) => i.file);

  const debounceMs = config.settings.debounceMs;

  const renderPipes = config.pipes.filter((p) => p.render);

  const pipesByTemplate = new Map<string, typeof renderPipes>();
  for (const pipe of renderPipes) {
    const list = pipesByTemplate.get(pipe.render!) || [];
    list.push(pipe);
    pipesByTemplate.set(pipe.render!, list);
  }

  for (const [templatePath, pipes] of pipesByTemplate) {
    if (fs.existsSync(templatePath)) {
      try {
        const changed = injectFile(templatePath, config);
        if (changed) {
          const template = fs.readFileSync(templatePath, "utf-8");
          const base = loadBase(config);
          const composed = composeContent(base, template.trim());
          for (const pipe of pipes) {
            const tmp = pipe.file + `.tmp-${randomBytes(4).toString("hex")}`;
            fs.writeFileSync(tmp, composed, "utf-8");
            fs.chmodSync(tmp, 0o444);
            fs.renameSync(tmp, pipe.file);
            log.info(`Rendered: ${templatePath} → ${pipe.file}`);
          }
        }
      } catch (err: unknown) {
        log.error(`Error rendering ${templatePath}: ${err}`);
      }
    }
  }

  const contextPipes = renderPipes.filter((p) => p.render);
  if (contextPipes.length > 0) {
    const contextFiles = contextPipes.map((p) => p.file);
    for (const cf of contextFiles) {
      if (fs.existsSync(cf)) {
        try {
          const templatePath = contextPipes.find((p) => p.file === cf)!.render!;
          const watcher = chokidar.watch(cf, {
            persistent: true,
            ignoreInitial: true,
            awaitWriteFinish: {
              stabilityThreshold: 1000,
              pollInterval: 200,
            },
          });

          let ctxTimer: NodeJS.Timeout | null = null;
          watcher.on("change", () => {
            if (writeBackGuard.value) return;
            if (ctxTimer) trackedClearTimeout(ctxTimer);
            ctxTimer = trackedSetTimeout(() => {
              ctxTimer = null;
              try {
                const data = fs.readFileSync(cf, "utf-8");
                handleIncomingWrite(data, templatePath, config, writeBackGuard);
              } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                log.error(`Error reading context file ${cf}: ${msg}`);
              }
            }, debounceMs);
          });

          log.info(`Watching context file for AI edits: ${cf}`);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn(`Could not watch context file ${cf}: ${msg}`);
        }
      }
    }
  }

  if (watchedFiles.length > 0) {
    const watcher = chokidar.watch(watchedFiles, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100,
      },
    });

    const debounceTimers = new Map<string, NodeJS.Timeout>();

    watcher.on("change", (file: string) => {
      const existing = debounceTimers.get(file);
      if (existing) {
        trackedClearTimeout(existing);
        log.info(`Debounced: ${file} (waiting ${debounceMs}ms)`);
      }

      debounceTimers.set(file, trackedSetTimeout(() => {
        debounceTimers.delete(file);

        const matchedPipes = renderPipes.filter((p) => p.render === file);
        if (matchedPipes.length > 0) {
          try {
            const changed = injectFile(file, config);
            if (changed) {
              const template = fs.readFileSync(file, "utf-8");
              const base = loadBase(config);
              const composed = composeContent(base, template.trim());
              for (const pipe of matchedPipes) {
                const tmp = pipe.file + `.tmp-${randomBytes(4).toString("hex")}`;
                fs.writeFileSync(tmp, composed, "utf-8");
                fs.chmodSync(tmp, 0o444);
                fs.renameSync(tmp, pipe.file);
                log.info(`Rendered: ${file} → ${pipe.file}`);
              }
            }
          } catch (err: unknown) {
            log.error(`Error rendering ${file}: ${err}`);
          }
          return;
        }

        try {
          const changed = injectFile(file, config);
          if (changed) {
            log.info(`Injected: ${file}`);
          }
        } catch (err: unknown) {
          log.error(`Error injecting ${file}: ${err}`);
        }
      }, debounceMs));
    });

    log.info(`Watching: ${watchedFiles.join(", ")} (debounce: ${debounceMs}ms)`);
  }
}
