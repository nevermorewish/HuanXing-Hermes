import { BRAND } from "@/lib/brand.generated";
import { useState } from "react";
import { useAtom, useSetAtom } from "jotai";
import { Dialog } from "@hermes/shared-ui";
import { Eye, EyeOff, X } from "lucide-react";
import { authDialogOpenAtom, huanxingAuthAtom } from "@/stores/auth";
import {
  DEFAULT_HUANXING_SERVER_URL,
  registerHuanxingAccount,
} from "@/lib/huanxing-auth";
import { useAccountFetchSetup, useAccountLogin, useAccountSaveModels } from "@/hooks/use-account";
import {
  selectBrandAccountEndpointTypes,
  selectBrandAccountModels,
} from "@/lib/brand-account-models";
import s from "./auth-dialog.module.css";

type AuthTab = "login" | "register";

export function AuthDialog() {
  const [open, setOpen] = useAtom(authDialogOpenAtom);
  const setAccount = useSetAtom(huanxingAuthAtom);
  const [tab, setTab] = useState<AuthTab>("login");
  const [serverUrl, setServerUrl] = useState(DEFAULT_HUANXING_SERVER_URL);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [email, setEmail] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [codeBusy, setCodeBusy] = useState(false);
  const [codeSentAt, setCodeSentAt] = useState(0);
  const ccwork = BRAND.accountBackend === "ccwork";
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const accountLogin = useAccountLogin();
  const accountFetchSetup = useAccountFetchSetup();
  const accountSaveModels = useAccountSaveModels();

  const resetFeedback = () => {
    setError("");
    setNotice("");
  };

  const switchTab = (next: AuthTab) => {
    setTab(next);
    resetFeedback();
  };

  const handleLogin = async (register = false) => {
    if (!username.trim() || !password) {
      setError("请输入用户名和密码。");
      return;
    }
    setBusy(true);
    resetFeedback();
    try {
      const user = register ? await window.hermesDesktop!.accountRegister!({
        baseUrl: serverUrl, contact: username.trim(), password, verificationCode, inviteCode,
      }) : await accountLogin.mutateAsync({
        baseUrl: serverUrl,
        username,
        password,
      });
      // Login only authenticates the account. Provision the server-selected
      // model catalog immediately so a new user cannot retain an old user's
      // provider/key or fall back to Core's provider guessing path.
      const setup = await accountFetchSetup.mutateAsync();
      const brandModels = selectBrandAccountModels(setup.models);
      if (brandModels.length > 0) {
        await accountSaveModels.mutateAsync({
          models: brandModels,
          modelEndpointTypes: selectBrandAccountEndpointTypes(
            setup.modelEndpointTypes,
            brandModels,
          ),
          primaryModelId: brandModels[0],
        });
      }
      setAccount({
        serverUrl: setup.baseUrl,
        userId: user.id,
        username: user.username,
        displayName: user.displayName,
      });
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  };

  const handleRegister = async () => {
    if (!username.trim() || !password) {
      setError("请输入用户名和密码。");
      return;
    }
    if (password.length < 8 || password.length > (ccwork ? 128 : 20)) {
      setError(ccwork ? "密码长度需为 8–128 位。" : "密码长度需为 8–20 位。");
      return;
    }
    if (password !== confirmPassword) {
      setError("两次输入的密码不一致。");
      return;
    }
    if (ccwork) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(username.trim()) && !/^1[3-9]\d{9}$/.test(username.trim())) { setError("请输入邮箱或中国大陆手机号。"); return; }
      if (!/^\d{6}$/.test(verificationCode)) { setError("请输入六位验证码。"); return; }
      const groups = [/[A-Z]/, /[a-z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((pattern) => pattern.test(password)).length;
      if (groups < 3) { setError("密码须包含大写、小写、数字、特殊字符中的至少三种。"); return; }
      await handleLogin(true);
      return;
    }
    setBusy(true);
    resetFeedback();
    try {
      await registerHuanxingAccount(serverUrl, username, password, email || undefined);
      setNotice("注册成功，请登录。");
      setTab("login");
      setPassword("");
      setConfirmPassword("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "注册失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  };

  const sendCode = async () => {
    if (Date.now() - codeSentAt < 60_000 || codeBusy) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(username.trim()) && !/^1[3-9]\d{9}$/.test(username.trim())) { setError("请输入邮箱或中国大陆手机号。"); return; }
    setCodeBusy(true); resetFeedback();
    try { await window.hermesDesktop!.accountSendVerificationCode!(username.trim(), inviteCode); setCodeSentAt(Date.now()); setNotice("验证码已发送，请查收；一分钟后可重新发送。"); }
    catch (err) { setError(err instanceof Error ? err.message : "发送验证码失败。"); }
    finally { setCodeBusy(false); }
  };
  const submit = tab === "login" ? () => handleLogin() : handleRegister;

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay />
        <Dialog.Content className={s.dialog} aria-describedby={undefined}>
          <Dialog.Title asChild>
            <span className={s.srOnly}>{tab === "login" ? "登录" : "注册"}</span>
          </Dialog.Title>
          <button type="button" className={s.close} aria-label="关闭" onClick={() => setOpen(false)}>
            <X size={16} />
          </button>

          <h3 className={s.title}>{ccwork ? "ccwork 账号" : "企业账号"}</h3>
          <div className={s.sub}>{ccwork ? "模型与用量由 ccwork 账号统一管理" : "账号登录与设备令牌绑定相互独立"}</div>

          <div className={s.tabs} role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "login"}
              className={s.tab}
              data-active={tab === "login" ? "true" : undefined}
              onClick={() => switchTab("login")}
            >
              登录
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "register"}
              className={s.tab}
              data-active={tab === "register" ? "true" : undefined}
              onClick={() => switchTab("register")}
            >
              注册
            </button>
          </div>

          <form
            className={s.form}
            onSubmit={(event) => {
              event.preventDefault();
              if (!busy) void submit();
            }}
          >
            {!ccwork && <label className={s.field}>
              <span className={s.label}>服务器地址</span>
              <input
                className={s.input}
                value={serverUrl}
                onChange={(event) => setServerUrl(event.target.value)}
                placeholder={DEFAULT_HUANXING_SERVER_URL}
                spellCheck={false}
                autoComplete="url"
              />
            </label>}
            <label className={s.field}>
              <span className={s.label}>{ccwork ? (tab === "register" ? "邮箱 / 手机号" : "用户名 / 邮箱 / 手机号") : "用户名"}</span>
              <input
                className={s.input}
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder={ccwork ? "ccwork 账号" : "企业账号用户名"}
                autoComplete="username"
                autoFocus
              />
            </label>
            <label className={s.field}>
              <span className={s.label}>密码</span>
              <span className={s.passwordWrap}>
                <input
                  className={s.input}
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder={tab === "register" ? (ccwork ? "8–128 位，至少三种字符类型" : "8–20 位密码") : "密码"}
                  autoComplete={tab === "login" ? "current-password" : "new-password"}
                />
                <button
                  type="button"
                  className={s.eye}
                  aria-label={showPassword ? "隐藏密码" : "显示密码"}
                  onClick={() => setShowPassword((value) => !value)}
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </span>
            </label>
            {tab === "register" ? (
              <>
                <label className={s.field}>
                  <span className={s.label}>确认密码</span>
                  <input
                    className={s.input}
                    type="password"
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                    placeholder="再次输入密码"
                    autoComplete="new-password"
                  />
                </label>
                {!ccwork && <label className={s.field}>
                  <span className={s.label}>邮箱（可选）</span>
                  <input
                    className={s.input}
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder="找回密码时使用"
                    autoComplete="email"
                  />
                </label>}
                {ccwork && <>
                  <label className={s.field}><span className={s.label}>邀请码（可选）</span><input className={s.input} value={inviteCode} onChange={(event) => setInviteCode(event.target.value)} autoComplete="off" /></label>
                  <label className={s.field}><span className={s.label}>验证码</span><input className={s.input} value={verificationCode} onChange={(event) => setVerificationCode(event.target.value)} inputMode="numeric" maxLength={6} autoComplete="one-time-code" placeholder="六位数字验证码" /></label>
                  <button type="button" className={s.submit} disabled={busy || codeBusy} onClick={() => void sendCode()}>{codeBusy ? "发送中…" : "发送验证码"}</button>
                </> }
              </>
            ) : null}

            {error ? <div className={s.error}>{error}</div> : null}
            {notice ? <div className={s.notice}>{notice}</div> : null}

            <button type="submit" className={s.submit} disabled={busy}>
              {busy ? "请稍候…" : tab === "login" ? "登 录" : "注 册"}
            </button>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
