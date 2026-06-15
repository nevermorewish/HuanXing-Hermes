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

function errorMessage(error: unknown): string | undefined {
  if (!error) return undefined;
  return error instanceof Error ? error.message : String(error);
}

function providerModels(entry: any): string[] {
  if (entry?.models && typeof entry.models === "object" && !Array.isArray(entry.models)) {
    return Object.keys(entry.models);
  }
  if (Array.isArray(entry?.models)) {
    return entry.models.filter((model: unknown): model is string => typeof model === "string");
  }
  return [];
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
  const accountProviderId = `custom:${BRAND.providerKey}`;
  const accountMessagesProviderId = `custom:${BRAND.providerKey}-messages`;
  const providerEntry = config?.providers?.[accountProviderId];
  const messagesProviderEntry = config?.providers?.[accountMessagesProviderId];
  const chatModels = providerModels(providerEntry);
  const messagesModels = providerModels(messagesProviderEntry);
  const accountModels = Array.from(new Set([...chatModels, ...messagesModels]));
  const configuredModel = config?.model && typeof config.model === "object" && !Array.isArray(config.model)
    ? config.model
    : {};
  const currentProvider = typeof configuredModel.provider === "string"
    ? configuredModel.provider
    : "";
  const currentModel = typeof configuredModel.model === "string"
    ? configuredModel.model
    : typeof configuredModel.default === "string"
      ? configuredModel.default
      : "";
  const primaryModel = accountModels.includes(currentModel)
    ? currentModel
    : typeof providerEntry?.model === "string"
      ? providerEntry.model
      : typeof messagesProviderEntry?.model === "string"
        ? messagesProviderEntry.model
        : accountModels[0];
  const currentAccountProvider = accountModels.includes(currentModel)
    && (currentProvider === accountProviderId || currentProvider === accountMessagesProviderId)
    ? currentProvider
    : "";
  const primaryProvider = currentAccountProvider
    ? currentProvider
    : messagesModels.includes(primaryModel)
      ? accountMessagesProviderId
      : accountProviderId;
  const selectedTokenId = typeof providerEntry?.token_id === "number"
    ? providerEntry.token_id
    : typeof providerEntry?.tokenId === "number"
      ? providerEntry.tokenId
      : typeof messagesProviderEntry?.token_id === "number"
        ? messagesProviderEntry.token_id
        : typeof messagesProviderEntry?.tokenId === "number"
          ? messagesProviderEntry.tokenId
          : "";

  const handleTokenSelect = async (tokenId: number) => {
    if (!Number.isFinite(tokenId) || tokenId <= 0) return;
    await saveModels.mutateAsync({
      models: [],
      tokenId,
    });
    if (primaryModel) {
      void setRuntimeModel(primaryModel, primaryProvider).catch(() => {
        /* gateway refresh is best-effort; config is already persisted */
      });
    }
  };
  const loadAccountTokens = () => {
    if (!accountTokens.data && !accountTokens.isFetching) {
      void accountTokens.refetch();
    }
  };
  const tokenLoadError = accountTokens.isError
    ? errorMessage(accountTokens.error) ?? "令牌加载失败"
    : undefined;

  const dialog = (
    <AccountLoginDialog
      open={dialogOpen}
      onOpenChange={setDialogOpen}
      defaultUsername={status?.user?.username}
    />
  );

  if (!loggedIn) {
    return (
      <>
        <button type="button" className={s.loginBtn} onClick={() => setDialogOpen(true)}>
          <LogIn size={14} /> 登录 {BRAND.appName}
        </button>
        {dialog}
      </>
    );
  }

  const balance = balanceQuery.data;
  const accountUserLabel = status?.user?.username || status?.user?.displayName || "已登录";
  const accountUserTitle = [status?.user?.username, status?.user?.displayName]
    .filter(Boolean)
    .join(" / ");
  return (
    <>
      <div className={s.panel}>
        <div className={s.row}>
          <span className={s.user} title={accountUserTitle || undefined}>
            {accountUserLabel}
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
            disabled={accountTokens.isFetching || saveModels.isPending}
            title={tokenLoadError}
            onFocus={loadAccountTokens}
            onMouseDown={loadAccountTokens}
            onChange={(event) => {
              const tokenId = Number(event.target.value);
              void handleTokenSelect(tokenId);
            }}
          >
            <option value="">
              {saveModels.isPending
                  ? "保存中..."
                  : accountTokens.isError
                    ? "令牌加载失败"
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
      {dialog}
    </>
  );
}
