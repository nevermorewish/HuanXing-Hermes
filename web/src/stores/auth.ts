import { BRAND } from "@/lib/brand.generated";
import { atom } from "jotai";
import { readUiValue, removeUiValue, writeUiValue } from "@/lib/ui-store";
import type { HuanxingAccount } from "@/lib/huanxing-auth";

const HUANXING_AUTH_KEY = BRAND.accountBackend === "ccwork" ? `hermes.${BRAND.id}-auth` : "hermes.huanxing-auth";
const TEAM_DEVICE_TOKEN_ONBOARDING_DISMISSED_KEY =
  "hermes.team-device-token-onboarding-dismissed";

function readStoredAccount(): HuanxingAccount | null {
  const value = readUiValue<HuanxingAccount | null>(HUANXING_AUTH_KEY, null);
  if (!value || typeof value !== "object") return null;
  if ((typeof value.userId !== "number" && typeof value.userId !== "string") || !value.username) return null;
  if (!value.accessToken && !value.sessionCookie) return null;
  return value;
}

const huanxingAuthBaseAtom = atom<HuanxingAccount | null>(readStoredAccount());

/** 企业账号登录态。 */
export const huanxingAuthAtom = atom(
  (get) => get(huanxingAuthBaseAtom),
  (_get, set, next: HuanxingAccount | null) => {
    set(huanxingAuthBaseAtom, next);
    if (next) { writeUiValue(HUANXING_AUTH_KEY, next); if (HUANXING_AUTH_KEY !== "hermes.huanxing-auth") writeUiValue("hermes.huanxing-auth", next); }
    else { removeUiValue(HUANXING_AUTH_KEY); removeUiValue("hermes.huanxing-auth"); }
  },
);

/** 登录 / 注册弹窗开关。 */
export const authDialogOpenAtom = atom<boolean>(false);

/** 企业设备令牌弹窗开关。令牌本身由 Rust 写入 profile 私有文件。 */
export const deviceTokenDialogOpenAtom = atom<boolean>(false);

export function isTeamDeviceTokenOnboardingDismissed(): boolean {
  return readUiValue<boolean>(TEAM_DEVICE_TOKEN_ONBOARDING_DISMISSED_KEY, false);
}

export function dismissTeamDeviceTokenOnboarding(): void {
  writeUiValue(TEAM_DEVICE_TOKEN_ONBOARDING_DISMISSED_KEY, true);
}

export function resetTeamDeviceTokenOnboarding(): void {
  removeUiValue(TEAM_DEVICE_TOKEN_ONBOARDING_DISMISSED_KEY);
}

/** Display names only; ccwork credentials never enter WebView storage. */
export const accountModelNamesAtom = atom<Record<string, string>>({});
