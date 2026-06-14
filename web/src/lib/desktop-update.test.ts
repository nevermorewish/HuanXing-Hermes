import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopUpdateManifestFetchResult } from "@hermes/protocol";
import {
  buildDesktopUpdateCheckResult,
  compareDesktopVersions,
  DESKTOP_UPDATE_DIALOG_EVENT,
  dispatchDesktopUpdateDialog,
  latestDesktopVersionFromManifest,
  normalizeDesktopVersion,
  shouldShowDesktopUpdateNotice,
} from "./desktop-update";

afterEach(() => {
  vi.unstubAllGlobals();
});

function fetchResult(overrides: Partial<DesktopUpdateManifestFetchResult> = {}): DesktopUpdateManifestFetchResult {
  return {
    ok: true,
    manifestUrl: "https://desktop.example.com/latest.json",
    manifest: { semver: "0.3.1", version: "v0.3.1" },
    checkedAtMs: 1_765_000_000_000,
    ...overrides,
  };
}

describe("desktop update version parsing", () => {
  it("normalizes valid desktop versions and rejects malformed values", () => {
    expect(normalizeDesktopVersion("v0.3.1")).toBe("0.3.1");
    expect(normalizeDesktopVersion("0.3.1+build.5")).toBe("0.3.1");
    expect(normalizeDesktopVersion("0.3.1-alpha.1")).toBe("0.3.1-alpha.1");
    expect(normalizeDesktopVersion("0.3")).toBeNull();
    expect(normalizeDesktopVersion("0.03.1")).toBeNull();
  });

  it("compares semver values including prereleases", () => {
    expect(compareDesktopVersions("0.3.1", "0.3.0")).toBeGreaterThan(0);
    expect(compareDesktopVersions("0.3.0", "0.3.0")).toBe(0);
    expect(compareDesktopVersions("0.2.9", "0.3.0")).toBeLessThan(0);
    expect(compareDesktopVersions("0.3.0", "0.3.0-alpha.1")).toBeGreaterThan(0);
    expect(compareDesktopVersions("bad", "0.3.0")).toBeNull();
  });
});

describe("desktop update manifest handling", () => {
  it("prefers semver over version when both are present", () => {
    expect(latestDesktopVersionFromManifest({ semver: "0.3.2", version: "v0.3.1" })).toBe("0.3.2");
  });

  it("falls back to version with v prefix", () => {
    expect(latestDesktopVersionFromManifest({ version: "v0.3.1" })).toBe("0.3.1");
  });

  it("reports update availability only for newer versions", () => {
    expect(buildDesktopUpdateCheckResult(fetchResult({ manifest: { semver: "0.3.0" } }), "0.3.0").updateAvailable).toBe(false);
    expect(buildDesktopUpdateCheckResult(fetchResult({ manifest: { semver: "0.3.1" } }), "0.3.0").updateAvailable).toBe(true);
    expect(buildDesktopUpdateCheckResult(fetchResult({ manifest: { semver: "0.2.9" } }), "0.3.0").updateAvailable).toBe(false);
  });

  it("turns malformed manifest versions into displayable errors", () => {
    const result = buildDesktopUpdateCheckResult(fetchResult({ manifest: { version: "latest" } }), "0.3.0");
    expect(result.ok).toBe(false);
    expect(result.updateAvailable).toBe(false);
    expect(result.error).toContain("缺少有效版本号");
  });

  it("preserves fetch errors and does not mark updates available", () => {
    const result = buildDesktopUpdateCheckResult(fetchResult({ ok: false, manifest: undefined, error: "HTTP 404" }), "0.3.0");
    expect(result.ok).toBe(false);
    expect(result.updateAvailable).toBe(false);
    expect(result.error).toBe("HTTP 404");
  });
});

describe("desktop update notification policy", () => {
  it("shows an auto notice whenever a newer version is available", () => {
    const result = buildDesktopUpdateCheckResult(fetchResult({ manifest: { semver: "0.3.1" } }), "0.3.0");
    expect(shouldShowDesktopUpdateNotice(result)).toBe(true);
    expect(shouldShowDesktopUpdateNotice({ ...result, latestVersion: undefined })).toBe(false);
    expect(shouldShowDesktopUpdateNotice({ ...result, updateAvailable: false })).toBe(false);
  });

  it("dispatches manual update dialog events with the check result", async () => {
    const result = buildDesktopUpdateCheckResult(fetchResult({ manifest: { semver: "0.3.1" } }), "0.3.0");
    const target = new EventTarget();
    vi.stubGlobal("window", target);
    const received = new Promise((resolve) => {
      target.addEventListener(DESKTOP_UPDATE_DIALOG_EVENT, (event) => resolve((event as CustomEvent).detail), { once: true });
    });

    dispatchDesktopUpdateDialog(result);

    await expect(received).resolves.toBe(result);
  });
});
