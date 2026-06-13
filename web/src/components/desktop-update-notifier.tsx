import { useEffect, useState } from "react";
import { Download, Sparkles } from "lucide-react";
import { Dialog } from "@hermes/shared-ui";
import type { DesktopUpdateCheckResult } from "@hermes/protocol";
import {
  checkDesktopUpdate,
  shouldShowDesktopUpdateNotice,
} from "@/lib/desktop-update";
import { BRAND } from "@/lib/brand.generated";
import { openExternalUrl } from "@/lib/external-links";
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

  const download = async () => {
    setOpen(false);
    await openExternalUrl(result?.downloadUrl);
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
            已发布 {versionLabel(result?.latestVersion)}，建议前往官网下载新版安装包，并按系统提示覆盖安装。当前应用不会自动下载安装包，也不会静默替换正在运行的程序。
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
          <div className={s.actions}>
            <button className={s.btn} type="button" onClick={close}>本版本不再提醒</button>
            <button className={s.btnPrimary} type="button" onClick={() => void download()}>
              <Download size={13} /> 去官网下载
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
