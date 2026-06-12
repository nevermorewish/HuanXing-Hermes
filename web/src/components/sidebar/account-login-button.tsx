import { useState } from "react";
import { LogIn, RefreshCw } from "lucide-react";
import { BRAND } from "@/lib/brand.generated";
import { openExternalUrl } from "@/lib/external-links";
import {
  isAccountLoginAvailable,
  useAccountBalance,
  useAccountLogout,
  useAccountStatus,
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
  const logout = useAccountLogout();

  // Hide entirely on non-desktop runtimes where the bridge is absent.
  if (!available) return null;

  const status = statusQuery.data;
  const loggedIn = Boolean(status?.loggedIn);

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
