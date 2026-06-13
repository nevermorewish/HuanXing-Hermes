import { useState } from "react";
import { LogIn, RefreshCw } from "lucide-react";
import { useConfig } from "@/hooks/use-config";
import { useGateway } from "@/hooks/use-gateway";
import { BRAND } from "@/lib/brand.generated";
import { openExternalUrl } from "@/lib/external-links";
import {
  isAccountLoginAvailable,
  useAccountBalance,
  useAccountLogout,
  useAccountSaveModels,
  useAccountStatus,
  useAccountTokens,
} from "@/hooks/use-account";
import { AccountLoginDialog } from "./account-login-dialog";
import s from "./account-login-button.module.css";

/** Format a newapi quota figure as a currency amount when the server says so. */
function formatBalance(
  quota: number,
  quotaPerUnit: number,
  displayInCurrency: boolean,
): string {
  if (!displayInCurrency || quotaPerUnit <= 0) {
    return `${Math.round(quota)}`;
  }
  return `$${(quota / quotaPerUnit).toFixed(2)}`;
}

export function AccountLoginButton() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const available = isAccountLoginAvailable();
  const statusQuery = useAccountStatus();
  const balanceQuery = useAccountBalance();
  const { data: config } = useConfig();
  const accountTokens = useAccountTokens();
  const saveModels = useAccountSaveModels();
  const { setRuntimeModel } = useGateway();
  const logout = useAccountLogout();

  // Hide entirely on non-desktop runtimes where the bridge is absent.
  if (!available) return null;

  const status = statusQuery.data;
  const loggedIn = Boolean(status?.loggedIn);
  const providerEntry = config?.providers?.[`custom:${BRAND.providerKey}`];
  const providerModels =
    providerEntry?.models && typeof providerEntry.models === "object" && !Array.isArray(providerEntry.models)
      ? Object.keys(providerEntry.models)
      : Array.isArray(providerEntry?.models)
        ? providerEntry.models.filter((model: unknown): model is string => typeof model === "string")
        : [];
  const primaryModel = typeof providerEntry?.model === "string"
    ? providerEntry.model
    : providerModels[0];
  const selectedTokenId = typeof providerEntry?.token_id === "number"
    ? providerEntry.token_id
    : typeof providerEntry?.tokenId === "number"
      ? providerEntry.tokenId
      : "";

  const handleTokenSelect = async (tokenId: number) => {
    if (!Number.isFinite(tokenId) || tokenId <= 0 || providerModels.length === 0) return;
    await saveModels.mutateAsync({
      models: providerModels,
      primaryModelId: primaryModel,
      tokenId,
    });
    if (primaryModel) {
      await setRuntimeModel(primaryModel, `custom:${BRAND.providerKey}`);
    }
  };

  if (!loggedIn) {
    return (
      <>
        <button type="button" className={s.loginBtn} onClick={() => setDialogOpen(true)}>
          <LogIn size={14} /> 登录 {BRAND.appName}
        </button>
        <AccountLoginDialog open={dialogOpen} onOpenChange={setDialogOpen} />
      </>
    );
  }

  const balance = balanceQuery.data;
  return (
    <>
      <div className={s.panel}>
        <div className={s.row}>
          <span className={s.user} title={status?.user?.username}>
            {status?.user?.displayName || status?.user?.username || "已登录"}
          </span>
          <button
            type="button"
            className={s.iconBtn}
            title="刷新余额"
            onClick={() => balanceQuery.refetch()}
          >
            <RefreshCw size={12} className={balanceQuery.isFetching ? s.spin : undefined} />
          </button>
        </div>
        {balance && (
          <div className={s.balance}>
            余额 {formatBalance(balance.quota, balance.quotaPerUnit, balance.displayInCurrency)}
          </div>
        )}
        <label className={s.tokenSelectRow}>
          <span>令牌</span>
          <select
            className={s.tokenSelect}
            value={selectedTokenId}
            disabled={accountTokens.isFetching || saveModels.isPending || providerModels.length === 0}
            onFocus={() => {
              if (!accountTokens.data && !accountTokens.isFetching && !accountTokens.isError) {
                void accountTokens.refetch();
              }
            }}
            onMouseDown={() => {
              if (!accountTokens.data && !accountTokens.isFetching && !accountTokens.isError) {
                void accountTokens.refetch();
              }
            }}
            onChange={(event) => {
              const tokenId = Number(event.target.value);
              void handleTokenSelect(tokenId);
            }}
          >
            <option value="">
              {providerModels.length === 0
                ? "先选择模型"
                : saveModels.isPending
                  ? "保存中..."
                  : accountTokens.isError
                    ? "令牌限流"
                  : accountTokens.isFetching
                    ? "加载中..."
                    : "选择令牌"}
            </option>
            {(accountTokens.data ?? []).map((token) => (
              <option key={token.id} value={token.id}>
                {token.name}{token.group ? ` (${token.group})` : ""}
              </option>
            ))}
          </select>
        </label>
        <div className={s.links}>
          <button
            type="button"
            className={s.linkBtn}
            onClick={() => openExternalUrl(BRAND.serviceUrl)}
          >
            官网
          </button>
          <button
            type="button"
            className={s.linkBtn}
            onClick={() => openExternalUrl(balance?.topUpUrl || BRAND.rechargeUrl)}
          >
            充值
          </button>
          <button
            type="button"
            className={s.linkBtn}
            onClick={() => logout.mutate()}
            disabled={logout.isPending}
          >
            登出
          </button>
        </div>
      </div>
      <AccountLoginDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        defaultUsername={status?.user?.username}
      />
    </>
  );
}
