import { describe, expect, it } from "vitest";
import { CAPABILITY_SECTIONS } from "./capability-sidebar";
import { GATEWAY_SECTIONS } from "./gateway-sidebar";
import { TOP_TABS } from "./use-active-top-tab";

describe("configuration navigation", () => {
  it("keeps the assistant hub and both supported platforms under §031", () => {
    const im = GATEWAY_SECTIONS.find((section) => section.label === "§031 · 助理接入");
    expect(im?.items.map((item) => [item.label, item.path])).toEqual([
      ["接入中心", "/im"],
      ["飞书", "/im/feishu"],
      ["微信", "/im/weixin"],
    ]);
  });

  it("uses the assistant hub as the 03 top tab entry", () => {
    const gatewayTab = TOP_TABS.find((tab) => tab.num === "03");
    expect(gatewayTab?.label).toBe("助理");
    expect(gatewayTab?.href).toBe("/im");
    expect(gatewayTab?.matches("/im/feishu")).toBe(true);
    expect(gatewayTab?.matches("/im/weixin")).toBe(true);
  });

  it("places backup and migration under §023 in the 02 configuration sidebar", () => {
    const backup = CAPABILITY_SECTIONS.find((section) => section.label === "§023 · 备份与恢复");
    expect(backup?.items.map((item) => [item.label, item.path])).toEqual([
      ["备份恢复", "/backup"],
      ["配置迁移", "/config-migration"],
    ]);
  });
});
