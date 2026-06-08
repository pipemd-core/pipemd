export type BlockScope = "shared" | "local";

export const BLOCK_SOURCES: readonly string[] = [
  "test-failures",
  "git-delta",
  "git-diff-stat",
  "git-staged",
  "git-context",
  "syntax-check",
  "edit-diff",
  "file-errors",
  "crew-status",
  "crew-locks",
  "crew-todos",
  "custom",
  "context-rules",
  "handoff",
  "import-graph",
  "session-diff",
] as const;

const BLOCK_SCOPES: Record<string, BlockScope> = {
  "test-failures": "shared",
  "git-delta": "shared",
  "git-diff-stat": "shared",
  "git-staged": "shared",
  "context-rules": "shared",
  "handoff": "shared",
  "syntax-check": "local",
  "edit-diff": "local",
  "file-errors": "local",
  "crew-status": "local",
  "crew-locks": "local",
  "crew-todos": "local",
  "git-context": "local",
  "custom": "local",
  "import-graph": "local",
  "session-diff": "local",
};

export function getBlockScope(source: string): BlockScope {
  return BLOCK_SCOPES[source] || "local";
}

export function isSharedBlock(source: string): boolean {
  return getBlockScope(source) === "shared";
}

export function getAllBlockScopes(): Record<string, BlockScope> {
  return { ...BLOCK_SCOPES };
}
