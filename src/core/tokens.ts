/**
 * Token estimation utility. The rough heuristic is ~4 bytes per token
 * (consistent with OpenAI's tokenizer average for English/code text).
 *
 * This is the canonical implementation for TS source files. The OpenCode
 * plugin (src/plugins/opencode-tui.js) has its own inline copy because it
 * runs as a standalone JS file without access to the compiled dist.
 */

export function estimateTokens(bytes: number): number {
  return Math.round(bytes / 4);
}

export function estimateTokensForText(text: string): number {
  return estimateTokens(Buffer.byteLength(text, "utf-8"));
}

export function formatTokenCount(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}
