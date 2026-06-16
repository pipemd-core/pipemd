import { Command } from "commander";
import { renderFleetSummary } from "../core/fleet-summary.js";

export const fleetCommand = new Command("fleet")
  .description("Show fleet topology from the relay (pull-based, read-only)")
  .action(async () => {
    const summary = await renderFleetSummary();
    process.stdout.write(summary);
  });
