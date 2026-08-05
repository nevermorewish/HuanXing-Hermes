import { describe, expect, it } from "vitest";
import type { AccountTokenInfo } from "@/lib/runtime";
import { preferredAccountTokenId, resolvedAccountTokenId } from "./account-tokens";

const token = (
  id: number,
  group: string,
  status = 1,
  name = `token-${id}`,
): AccountTokenInfo => ({ id, group, status, name });

describe("account token selection", () => {
  it("prefers an active token in the default group", () => {
    expect(preferredAccountTokenId([
      token(1, "team"),
      token(2, "DEFAULT", 2),
      token(3, " default "),
    ])).toBe(3);
  });

  it("preserves a configured token that still belongs to the current user", () => {
    const tokens = [token(1, "default"), token(2, "team")];
    expect(resolvedAccountTokenId(tokens, 2)).toBe(2);
  });

  it("does not preserve a disabled configured token", () => {
    const tokens = [token(1, "default"), token(2, "team", 2)];
    expect(resolvedAccountTokenId(tokens, 2)).toBe(1);
  });

  it("falls back to the default group when the configured token is stale", () => {
    const tokens = [token(1, "team"), token(2, "default")];
    expect(resolvedAccountTokenId(tokens, 99)).toBe(2);
  });
});
