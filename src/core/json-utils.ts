import fs from "node:fs";

export function tryReadJson(p: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

export function isPidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
}

export function readInjectStats(statsFile: string): { delivered: number; dedup: number; lastEvent?: any } {
  const s = tryReadJson(statsFile);
  return {
    delivered: typeof s?.delivered === "number" ? s.delivered : 0,
    dedup: typeof s?.dedup === "number" ? s.dedup : 0,
    lastEvent: s?.lastEvent,
  };
}

export function formatTimeAgo(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime();
  if (diff < 0) return "just now";
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  return `${days}d`;
}
