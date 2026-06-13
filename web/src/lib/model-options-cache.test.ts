import { describe, expect, it } from "vitest";
import {
  getCachedModelOptions,
  invalidateModelOptionsCache,
} from "./model-options-cache";

describe("model options cache", () => {
  it("deduplicates concurrent loads and fetches fresh values afterward", async () => {
    invalidateModelOptionsCache();
    let calls = 0;
    let now = 1000;
    const loader = async () => {
      calls += 1;
      return { providers: [{ slug: "local", models: ["m1"] }], model: "m1" };
    };

    const [first, second] = await Promise.all([
      getCachedModelOptions(undefined, loader, () => now),
      getCachedModelOptions(undefined, loader, () => now),
    ]);
    expect(calls).toBe(1);
    expect(first).toBe(second);

    now += 1;
    const fresh = await getCachedModelOptions(undefined, loader, () => now);
    expect(fresh).not.toBe(first);
    expect(calls).toBe(2);
  });

  it("keeps in-flight requests session-scoped", async () => {
    invalidateModelOptionsCache();
    let calls = 0;
    const loader = async () => {
      calls += 1;
      return { providers: [{ slug: `p${calls}` }] };
    };

    const first = await getCachedModelOptions("s1", loader);
    const second = await getCachedModelOptions("s2", loader);
    expect(first.providers[0]?.slug).toBe("p1");
    expect(second.providers[0]?.slug).toBe("p2");

    const [refreshed, stillFresh] = await Promise.all([
      getCachedModelOptions("s1", loader),
      getCachedModelOptions("s2", loader),
    ]);
    expect(refreshed.providers[0]?.slug).toBe("p3");
    expect(stillFresh.providers[0]?.slug).toBe("p4");
    expect(refreshed).not.toBe(first);
    expect(stillFresh).not.toBe(second);
  });
});
