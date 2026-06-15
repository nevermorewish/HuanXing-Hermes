import type { AccountTokenInfo } from "@/lib/runtime";

export function preferredAccountTokenId(tokens: readonly AccountTokenInfo[]): number | null {
  const token = tokens.find((t) => t.status === 1 && t.group.trim().toLowerCase() === "default")
    ?? tokens.find((t) => t.group.trim().toLowerCase() === "default")
    ?? tokens.find((t) => t.status === 1)
    ?? tokens[0];
  return token ? token.id : null;
}
