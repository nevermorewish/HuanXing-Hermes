import { useEffect, useState } from "react";
import { Download, Sparkles } from "lucide-react";
import { Dialog } from "@hermes/shared-ui";
import type { DesktopUpdateCheckResult } from "@hermes/protocol";
import {
  checkDesktopUpdate,
  shouldShowDesktopUpdateNotice,
} from "@/lib/desktop-update";
import { BRAND } from "@/lib/brand.generated";
import { runtime } from "@/lib/runtime";
import { versionLabel } from "@/lib/build-info";
import s from "./desktop-update-notifier.module.css";

let autoCheckPromise: Promise<DesktopUpdateCheckResult> | null = null;

function startAutoCheckIfNeeded(): Promise<DesktopUpdateCheckResult> | null {
  if (autoCheckPromise) return autoCheckPromise;

  autoCheckPromise = checkDesktopUpdate();
  return autoCheckPromise;
}

export function DesktopUpdateNotifier() {
  const [result, setResult] = useState<DesktopUpdateCheckResult | null>(null);
  const [open, setOpen] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installMessage, setInstallMessage] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);

  useEffect(() => {
    if (runtime.platform === "web" || !window.hermesDesktop?.checkDesktopUpdate) return;

    let cancelled = false;
    const promise = startAutoCheckIfNeeded();
    if (!promise) return;

    promise.then((next) => {
      if (cancelled) return;
      if (shouldShowDesktopUpdateNotice(next)) {
        setResult(next);
        setOpen(true);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const close = () => {
    setOpen(false);
  };

  const install = async () => {
    if (!window.hermesDesktop?.installDesktopUpdate) {
      setInstallError("当前环境没有自动安装能力");
      return;
    }
    setInstalling(true);
    setInstallError(null);
    setInstallMessage("正在下载安装包…");
    try {
      const installResult = await window.hermesDesktop.installDesktopUpdate();
      if (!installResult.ok) {
        setInstallError(installResult.error ?? "桌面端更新安装失败");
        setInstallMessage(null);
        return;
      }
      const fileName = installResult.asset?.fileName ?? installResult.filePath?.split(/[\\/]/).pop();
      setInstallMessage(
        fileName
          ? `安装包已下载并打开：${fileName}。请按系统提示完成覆盖安装。`
          : "安装包已下载并打开。请按系统提示完成覆盖安装。",
      );
    } catch (error) {
      setInstallError(error instanceof Error ? error.message : String(error || "桌面端更新安装失败"));
      setInstallMessage(null);
    } finally {
      setInstalling(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(next) => next ? setOpen(true) : close()}>
      <Dialog.Portal>
        <Dialog.Overlay />
        <Dialog.Content className={s.dialog} aria-describedby="desktop-update-desc">
          <Dialog.Title className={s.title}>
            <span className={s.titleIcon}><Sparkles size={17} aria-hidden="true" /></span>
            {`发现 ${BRAND.appName} 桌面端新版本`}
          </Dialog.Title>
          <Dialog.Description id="desktop-update-desc" className={s.body}>
            已发布 {versionLabel(result?.latestVersion)}。点击“下载安装”会下载当前系统的安装包并自动打开，请按系统提示完成覆盖安装。
          </Dialog.Description>
          <div className={s.versionPanel} aria-label="桌面端版本信息">
            <div>
              <span>当前版本</span>
              <b>{versionLabel(result?.currentVersion)}</b>
            </div>
            <div>
              <span>最新版本</span>
              <b>{versionLabel(result?.latestVersion)}</b>
            </div>
          </div>
          {(installMessage || installError) && (
            <div className={s.installMessage} data-tone={installError ? "error" : "normal"}>
              {installError ?? installMessage}
            </div>
          )}
          <div className={s.actions}>
            <button className={s.btn} type="button" onClick={close} disabled={installing}>本版本不再提醒</button>
            <button
              className={s.btnPrimary}
              type="button"
              onClick={() => void install()}
              disabled={installing || !window.hermesDesktop?.installDesktopUpdate}
            >
              <Download size={13} /> {installing ? "下载中…" : "下载安装"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
