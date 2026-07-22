import { describe, expect, it } from "vitest";
import { advanceBackendGate, type BackendGateTracker } from "./use-backend-gate";

const INITIAL: BackendGateTracker = { gate: "offline", staleStartedAt: null };

describe("advanceBackendGate", () => {
  it("stays offline after a stale boot timeout instead of restarting the timer", () => {
    const booting = advanceBackendGate(INITIAL, 0, false, "running", undefined);
    const offline = advanceBackendGate(booting, 90_000, false, "running", undefined);
    const stillOffline = advanceBackendGate(offline, 93_000, false, "running", undefined);

    expect(booting).toEqual({ gate: "booting", staleStartedAt: 0 });
    expect(offline).toEqual({ gate: "offline", staleStartedAt: 0 });
    expect(stillOffline).toEqual({ gate: "offline", staleStartedAt: 0 });
  });

  it("resets the stale timer after recovery and starts a new window on a later disconnect", () => {
    const booting = advanceBackendGate(INITIAL, 0, false, "running", undefined);
    const ready = advanceBackendGate(booting, 10_000, true, "running", undefined);
    const disconnected = advanceBackendGate(ready, 20_000, false, "running", undefined);

    expect(ready).toEqual({ gate: "ready", staleStartedAt: null });
    expect(disconnected).toEqual({ gate: "booting", staleStartedAt: 20_000 });
  });

  it("does not age a real installing or starting lifecycle", () => {
    const stale = advanceBackendGate(INITIAL, 0, false, "running", undefined);
    const installing = advanceBackendGate(stale, 100_000, false, "running", "installing");

    expect(installing).toEqual({ gate: "booting", staleStartedAt: null });
  });
});
