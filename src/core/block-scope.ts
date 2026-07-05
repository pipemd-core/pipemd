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
  "custom",
  "handoff",
  "import-graph",
  "session-diff",
  "session-validate",
  "exports",
  "now",
  "dead-code",
] as const;

const BLOCK_SCOPES: Record<string, BlockScope> = {
  "test-failures": "shared",
  "git-delta": "shared",
  "git-diff-stat": "shared",
  "git-staged": "shared",
  "handoff": "shared",
  "now": "shared",
  "syntax-check": "local",
  "edit-diff": "local",
  "file-errors": "local",
  "crew-status": "local",
  "crew-locks": "local",
  "session-validate": "local",
  "git-context": "local",
  "custom": "local",
  "import-graph": "local",
  "session-diff": "local",
  "exports": "local",
  "dead-code": "shared",
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
