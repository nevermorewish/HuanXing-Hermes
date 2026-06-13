import type { ModelOptionsResult } from "@hermes/protocol";

export const MODEL_OPTIONS_CACHE_TTL_MS = 5 * 60_000;

interface ModelOptionsCacheEntry {
  value?: ModelOptionsResult;
  fetchedAt?: number;
  promise?: Promise<ModelOptionsResult>;
}

const cache = new Map<string, ModelOptionsCacheEntry>();

function cacheKey(sessionId?: string): string {
  const normalized = sessionId?.trim();
  return normalized ? `session:${normalized}` : "global";
}

export function invalidateModelOptionsCache(sessionId?: string): void {
  if (sessionId === undefined) {
    cache.clear();
    return;
  }
  cache.delete(cacheKey(sessionId));
}

export function getCachedModelOptions(
  sessionId: string | undefined,
  loader: () => Promise<ModelOptionsResult>,
  now = Date.now,
): Promise<ModelOptionsResult> {
  const key = cacheKey(sessionId);
  const cached = cache.get(key);

  // Caching disabled: always fetch a fresh list so newly configured account
  // models appear immediately and stale provider lists don't linger. An
  // in-flight request is still shared to avoid duplicate concurrent fetches.
  if (cached?.promise) return cached.promise;

  const promise = loader().then(
    (value) => {
      cache.delete(key);
      return value;
    },
    (error) => {
      cache.delete(key);
      throw error;
    },
  );
  cache.set(key, { promise });
  return promise;
}
