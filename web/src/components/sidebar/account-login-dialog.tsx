import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { BRAND } from "@/lib/brand.generated";
import {
  useAccountFetchSetup,
  useAccountLogin,
  useAccountSaveModels,
} from "@/hooks/use-account";
import type { AccountSetupResult, AccountTokenInfo } from "@/lib/runtime";
import s from "./account-login-dialog.module.css";

interface AccountLoginDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Models already configured for the account provider, to pre-check. */
  configuredModels?: string[];
  defaultUsername?: string;
}

type Step = "credentials" | "models";

export function AccountLoginDialog({
  open,
  onOpenChange,
  configuredModels = [],
  defaultUsername = "",
}: AccountLoginDialogProps) {
  const [step, setStep] = useState<Step>("credentials");
  const [serverUrl, setServerUrl] = useState(BRAND.serviceUrl);
  const [username, setUsername] = useState(defaultUsername);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const [setup, setSetup] = useState<AccountSetupResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [tokens, setTokens] = useState<AccountTokenInfo[]>([]);
  const [tokenId, setTokenId] = useState<number | null>(null);

  const login = useAccountLogin();
  const fetchSetup = useAccountFetchSetup();
  const saveModels = useAccountSaveModels();

  // Guard so re-opening the dialog after a successful login doesn't wipe a
  // selection the user is mid-way through (mirrors Claw's ref-guarded reset).
  const initializedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!open) {
      initializedFor.current = null;
      return;
    }
    if (initializedFor.current === "open") return;
    initializedFor.current = "open";
    setStep("credentials");
    setServerUrl(BRAND.serviceUrl);
    setUsername(defaultUsername);
    setPassword("");
    setError(null);
    setSetup(null);
    setSelected(new Set());
    setTokens([]);
    setTokenId(null);
  }, [open, defaultUsername]);

  const handleLogin = async () => {
    setError(null);
    try {
      await login.mutateAsync({ baseUrl: serverUrl.trim(), username: username.trim(), password });
      const result = await fetchSetup.mutateAsync();
      setSetup(result);
      // Pre-check already-configured models, else default to all.
      const preset = configuredModels.length > 0
        ? new Set(result.models.filter((m) => configuredModels.includes(m)))
        : new Set(result.models);
      setSelected(preset.size > 0 ? preset : new Set(result.models));
      // Lazily load tokens for the selector; failure is non-fatal.
      try {
        const list = await window.hermesDesktop?.accountListTokens?.();
        if (list) {
          setTokens(list);
          const def = list.find((t) => !t.group) ?? list.find((t) => t.status === 1) ?? list[0];
          setTokenId(def ? def.id : null);
        }
      } catch {
        /* token selector is optional */
      }
      setStep("models");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const toggleModel = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSave = async () => {
    setError(null);
    const models = Array.from(selected);
    if (models.length === 0) {
      setError("请至少选择一个模型");
      return;
    }
    try {
      await saveModels.mutateAsync({
        models,
        primaryModelId: models[0],
        tokenId: tokenId ?? undefined,
      });
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const busy = login.isPending || fetchSetup.isPending;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={s.overlay} />
        <Dialog.Content className={s.content}>
          <div className={s.header}>
            <Dialog.Title className={s.title}>
              {step === "credentials" ? `登录 ${BRAND.appName}` : "选择模型"}
            </Dialog.Title>
            <Dialog.Close className={s.close} aria-label="关闭">
              <X size={16} />
            </Dialog.Close>
          </div>

          {step === "credentials" ? (
            <div className={s.body}>
              <label className={s.field}>
                <span className={s.label}>服务地址</span>
                <input
                  className={s.input}
                  value={serverUrl}
                  onChange={(e) => setServerUrl(e.target.value)}
                  placeholder={BRAND.serviceUrl}
                  spellCheck={false}
                />
              </label>
              <label className={s.field}>
                <span className={s.label}>用户名</span>
                <input
                  className={s.input}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                />
              </label>
              <label className={s.field}>
                <span className={s.label}>密码</span>
                <input
                  className={s.input}
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !busy) handleLogin();
                  }}
                />
              </label>
              {error && <p className={s.error}>{error}</p>}
              <div className={s.actions}>
                <button
                  type="button"
                  className={s.primary}
                  disabled={busy || !serverUrl.trim() || !username.trim() || !password}
                  onClick={handleLogin}
                >
                  {busy ? "登录中…" : "登录"}
                </button>
              </div>
            </div>
          ) : (
            <div className={s.body}>
              {setup && (
                <p className={s.hint}>
                  账户 <strong>{setup.user.displayName}</strong> 可用模型 {setup.models.length} 个
                </p>
              )}
              {tokens.length > 0 && (
                <label className={s.field}>
                  <span className={s.label}>API 令牌</span>
                  <select
                    className={s.input}
                    value={tokenId ?? ""}
                    onChange={(e) => setTokenId(e.target.value ? Number(e.target.value) : null)}
                  >
                    {tokens.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}{t.group ? ` (${t.group})` : ""}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <div className={s.modelList}>
                {setup?.models.map((m) => (
                  <label key={m} className={s.modelRow}>
                    <input
                      type="checkbox"
                      checked={selected.has(m)}
                      onChange={() => toggleModel(m)}
                    />
                    <span>{m}</span>
                  </label>
                ))}
              </div>
              {error && <p className={s.error}>{error}</p>}
              <div className={s.actions}>
                <button type="button" className={s.secondary} onClick={() => setStep("credentials")}>
                  返回
                </button>
                <button
                  type="button"
                  className={s.primary}
                  disabled={saveModels.isPending || selected.size === 0}
                  onClick={handleSave}
                >
                  {saveModels.isPending ? "保存中…" : `保存 ${selected.size} 个模型`}
                </button>
              </div>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
