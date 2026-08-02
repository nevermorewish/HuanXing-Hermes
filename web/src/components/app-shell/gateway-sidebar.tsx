import { Link, useLocation } from "react-router-dom";
import { Bot, MessageCircle, MessageSquareText, type LucideIcon } from "lucide-react";
import s from "./debug-sidebar.module.css";

interface GatewayItem {
  label: string;
  path: string;
  icon: LucideIcon;
  title?: string;
}

export const IM_ITEMS: readonly GatewayItem[] = [
  { label: "接入中心", path: "/im", icon: Bot, title: "选择 Hermes 助理的聊天平台" },
  { label: "飞书", path: "/im/feishu", icon: MessageCircle, title: "将 Hermes 接入飞书" },
  { label: "微信", path: "/im/weixin", icon: MessageSquareText, title: "将 Hermes 接入微信" },
];

export const GATEWAY_SECTIONS: readonly {
  label: string;
  items: readonly GatewayItem[];
}[] = [
  { label: "§031 · 助理接入", items: IM_ITEMS },
];

export function GatewaySidebar() {
  const location = useLocation();
  const isActive = (path: string) =>
    path === "/im"
      ? location.pathname === path || location.pathname === "/im/"
      : location.pathname === path || location.pathname.startsWith(`${path}/`);

  return (
    <aside className={s.sidebar} aria-label="助理接入侧栏">
      <div className={s.scrollY}>
        {GATEWAY_SECTIONS.map((section) => (
          <section key={section.label} className={s.section}>
            <div className={s.label}>
              <span>{section.label}</span>
              <span className={s.labelNum}>✕✕</span>
            </div>
            {section.items.map((item) => {
              const Icon = item.icon;
              return (
                <Link
                  key={item.path}
                  to={item.path}
                  className={s.item}
                  data-active={isActive(item.path) ? "true" : undefined}
                  title={item.title ?? item.path}
                >
                  <span className={s.itemIcon}>
                    <Icon size={14} />
                  </span>
                  <span className={s.itemLabel}>{item.label}</span>
                  <span className={s.itemPath}>{item.path}</span>
                </Link>
              );
            })}
          </section>
        ))}
      </div>
    </aside>
  );
}
