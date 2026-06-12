import { useEffect, useMemo, useState } from "react";
import { SectionShell } from "./section-shell";
import {
  clearModelUsageLog,
  readModelUsageLog,
  subscribeModelUsage,
  type ModelUsageEntry,
} from "@/lib/model-usage-log";
import s from "./usage.module.css";

type WindowKey = "1d" | "7d" | "all";

const WINDOW_OPTIONS: { key: WindowKey; label: string; ms: number }[] = [
  { key: "1d", label: "近 24 小时", ms: 24 * 60 * 60 * 1000 },
  { key: "7d", label: "近 7 天", ms: 7 * 24 * 60 * 60 * 1000 },
  { key: "all", label: "全部", ms: Number.POSITIVE_INFINITY },
];

function useModelUsage(): ModelUsageEntry[] {
  const [entries, setEntries] = useState<ModelUsageEntry[]>(() => readModelUsageLog());
  useEffect(() => {
    const refresh = () => setEntries(readModelUsageLog());
    refresh();
    return subscribeModelUsage(refresh);
  }, []);
  return entries;
}

function formatWhen(ms: number): string {
  const diff = Date.now() - ms;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  return new Date(ms).toLocaleDateString("zh-CN");
}

export function UsageRoute() {
  const entries = useModelUsage();
  const [windowKey, setWindowKey] = useState<WindowKey>("7d");
  const [groupByProvider, setGroupByProvider] = useState(false);

  const windowMs = WINDOW_OPTIONS.find((w) => w.key === windowKey)?.ms ?? Infinity;
  const now = Date.now();

  const filtered = useMemo(
    () => entries.filter((e) => now - e.lastUsedAt <= windowMs),
    [entries, windowMs, now],
  );

  const totalPicks = filtered.reduce((acc, e) => acc + e.count, 0);

  const rows = useMemo(() => {
    if (!groupByProvider) {
      return [...filtered].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
    }
    // Group-by provider: aggregate counts, keep most recent lastUsedAt.
    const byProvider = new Map<string, ModelUsageEntry>();
    for (const e of filtered) {
      const key = e.providerName || e.provider || "（默认）";
      const prior = byProvider.get(key);
      byProvider.set(key, {
        key,
        model: prior ? `${prior.count + e.count} 次调用` : "",
        provider: e.provider,
        providerName: key,
        count: (prior?.count ?? 0) + e.count,
        lastUsedAt: Math.max(prior?.lastUsedAt ?? 0, e.lastUsedAt),
      });
    }
    return [...byProvider.values()].sort((a, b) => b.count - a.count);
  }, [filtered, groupByProvider]);

  const right = (
    <div className={s.toolbar}>
      <div className={s.segment}>
        {WINDOW_OPTIONS.map((w) => (
          <button
            key={w.key}
            type="button"
            className={s.segBtn}
            data-active={windowKey === w.key ? "true" : undefined}
            onClick={() => setWindowKey(w.key)}
          >
            {w.label}
          </button>
        ))}
      </div>
      <button
        type="button"
        className={s.toggle}
        data-active={groupByProvider ? "true" : undefined}
        onClick={() => setGroupByProvider((v) => !v)}
      >
        按服务商分组
      </button>
    </div>
  );

  return (
    <SectionShell title="模型用量" sub="本机模型选用记录" right={right}>
      <div className={s.summary}>
        <div className={s.stat}>
          <span className={s.statNum}>{filtered.length}</span>
          <span className={s.statLabel}>{groupByProvider ? "服务商" : "模型"}</span>
        </div>
        <div className={s.stat}>
          <span className={s.statNum}>{totalPicks}</span>
          <span className={s.statLabel}>总选用次数</span>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className={s.empty}>该时间范围内暂无模型选用记录。</div>
      ) : (
        <table className={s.table}>
          <thead>
            <tr>
              <th>{groupByProvider ? "服务商" : "模型"}</th>
              {!groupByProvider && <th>服务商</th>}
              <th className={s.numCol}>选用次数</th>
              <th className={s.numCol}>最近使用</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.key}>
                <td className={s.modelCell}>{groupByProvider ? e.providerName : e.model}</td>
                {!groupByProvider && (
                  <td className={s.providerCell}>{e.providerName || e.provider || "—"}</td>
                )}
                <td className={s.numCol}>{e.count}</td>
                <td className={s.numCol}>{formatWhen(e.lastUsedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {entries.length > 0 && (
        <div className={s.footer}>
          <button type="button" className={s.clearBtn} onClick={() => clearModelUsageLog()}>
            清空记录
          </button>
        </div>
      )}
    </SectionShell>
  );
}
