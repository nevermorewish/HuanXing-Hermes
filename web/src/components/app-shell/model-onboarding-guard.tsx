import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { LogIn, Sparkles } from "lucide-react";
import { BRAND } from "@/lib/brand.generated";
import { isAccountLoginAvailable, useAccountStatus } from "@/hooks/use-account";
import { AccountLoginDialog } from "@/components/sidebar/account-login-dialog";
import s from "./model-onboarding-guard.module.css";

let dismissedForWindow = false;

/** Brand display name (pure brand name, no "桌面版" edition suffix). */
function brandName(): string {
  return BRAND.appName;
}

export function ModelOnboardingGuard() {
  const location = useLocation();
  const available = isAccountLoginAvailable();
  const { data: status, isLoading, isError } = useAccountStatus();
  const [dismissed, setDismissed] = useState(() => dismissedForWindow);
  const [loginOpen, setLoginOpen] = useState(false);

  const loggedIn = Boolean(status?.loggedIn);

  useEffect(() => {
    if (!loggedIn) return;
    dismissedForWindow = false;
    setDismissed(false);
  }, [loggedIn]);

  if (
    !available ||
    isLoading ||
    isError ||
    (loggedIn && !loginOpen) ||
    dismissed ||
    location.pathname.startsWith("/models") ||
    location.pathname.startsWith("/console")
  ) {
    return null;
  }

  const dismiss = () => {
    dismissedForWindow = true;
    setDismissed(true);
  };

  return (
    <div className={s.backdrop} role="presentation">
      <section className={s.card} role="dialog" aria-modal="true" aria-labelledby="model-onboarding-title">
        <div className={s.iconWrap} aria-hidden="true">
          <Sparkles size={22} />
        </div>
        <div className={s.copy}>
          <p className={s.kicker}>欢迎使用</p>
          <h2 id="model-onboarding-title">请先登录 {brandName()}</h2>
          <p>
            登录你的 {brandName()} 账户即可一键启用模型服务，无需手动配置 API Key。
            登录后选择想用的模型，就能立即开始对话。
          </p>
        </div>
        <div className={s.actions}>
          <button type="button" className={s.secondary} onClick={dismiss}>先看看界面</button>
          <button type="button" className={s.primary} onClick={() => setLoginOpen(true)} autoFocus>
            <LogIn size={14} /> 登录
          </button>
        </div>
      </section>
      <AccountLoginDialog open={loginOpen} onOpenChange={setLoginOpen} />
    </div>
  );
}
