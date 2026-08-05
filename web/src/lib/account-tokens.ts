import type { AccountTokenInfo } from "@/lib/runtime";

export function preferredAccountTokenId(tokens: readonly AccountTokenInfo[]): number | null {
  const token = tokens.find((t) => t.status === 1 && t.group.trim().toLowerCase() === "default")
    ?? tokens.find((t) => t.status === 1)
    ?? tokens[0];
  return token ? token.id : null;
}

export function resolvedAccountTokenId(
  tokens: readonly AccountTokenInfo[],
  configuredTokenId: number | null,
): number | null {
  if (configuredTokenId != null && tokens.some(
    (token) => token.id === configuredTokenId && token.status === 1,
  )) {
    return configuredTokenId;
  }
  return preferredAccountTokenId(tokens);
}
