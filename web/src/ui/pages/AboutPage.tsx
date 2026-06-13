import { useCallback, useState } from "react";
import {
  checkForUpdates,
  downloadUpdate,
  installUpdate,
  onUpdateProgress,
} from "@/bridge/settings";
import type { UpdateState } from "@/types/update";
import { Button } from "@/ui/components/Button";
import { Modal } from "@/ui/components/Modal";
import { Toggle } from "@/ui/components/Toggle";
import {
  PageHeader,
  PageLayout,
  Section,
  SectionContent,
  SectionItem,
  SectionItemList,
} from "@/ui/layout/PageLayout";
import { useSettings } from "@/ui/SettingsProvider";

const LICENSE_TEXT = `MIT License

Copyright (c) 2024-2025 VoicePaste

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

export function AboutPage() {
  const { settings, scheduleSave } = useSettings();
  const cfg = settings?.parsedConfig || ({} as Record<string, unknown>);
  const app = (cfg.app || {}) as Record<string, unknown>;

  const [updateState, setUpdateState] = useState<UpdateState>("idle");
  const [updateVersion, setUpdateVersion] = useState("");
  const [statusText, setStatusText] = useState("-");
  const [licenseOpen, setLicenseOpen] = useState(false);
  const [betaUpdates, setBetaUpdates] = useState(!!app.beta_updates);

  const version = (settings?.runtime?.version as string) || "2.0.0";

  // Auto-check updates once
  const hasChecked = useState(false);

  if (!hasChecked[0] && updateState === "idle") {
    hasChecked[0] = true;
    setUpdateState("checking");
    setStatusText("正在检查…");
    checkForUpdates()
      .then((result) => {
        if (result.available) {
          setUpdateState("available");
          setUpdateVersion(result.version || "");
          setStatusText(`新版本 ${result.version} 可用`);
        } else {
          setUpdateState("not-available");
          setStatusText("已是最新版本");
        }
      })
      .catch(() => {
        setUpdateState("error");
        setStatusText("检查失败");
      });
  }

  const handleCheckUpdate = useCallback(async () => {
    setUpdateState("checking");
    setStatusText("正在检查…");
    try {
      const result = await checkForUpdates();
      if (result.available) {
        setUpdateState("available");
        setUpdateVersion(result.version || "");
        setStatusText(`新版本 ${result.version} 可用`);
      } else {
        setUpdateState("not-available");
        setStatusText("已是最新版本");
      }
    } catch {
      setUpdateState("error");
      setStatusText("检查失败");
    }
  }, []);

  const handleDownload = useCallback(async () => {
    setUpdateState("downloading");
    setStatusText("下载中…");
    const cleanup = onUpdateProgress((p) => {
      if (p.finished) {
        setUpdateState("downloaded");
        setStatusText("下载完成");
      } else if (p.downloaded !== undefined && p.contentLength) {
        const pct = Math.round((p.downloaded / p.contentLength) * 100);
        setStatusText(`下载中 ${pct}%`);
      }
    });
    try {
      await downloadUpdate();
    } catch {
      setUpdateState("error");
      setStatusText("下载失败");
    }
    cleanup();
  }, []);

  const handleInstall = useCallback(async () => {
    setUpdateState("installing");
    await installUpdate();
  }, []);

  const updateBtnState: Record<
    UpdateState,
    {
      label: string;
      variant: "default" | "accent" | "danger" | "ghost";
      disabled: boolean;
      onClick: () => void;
    }
  > = {
    idle: { label: "检查更新", variant: "accent", disabled: false, onClick: handleCheckUpdate },
    checking: { label: "正在检查…", variant: "default", disabled: true, onClick: () => {} },
    "not-available": { label: "已是最新", variant: "default", disabled: true, onClick: () => {} },
    available: {
      label: `下载 ${updateVersion}`,
      variant: "accent",
      disabled: false,
      onClick: handleDownload,
    },
    downloading: { label: "下载中…", variant: "default", disabled: true, onClick: () => {} },
    downloaded: { label: "重启安装", variant: "accent", disabled: false, onClick: handleInstall },
    error: { label: "重试", variant: "danger", disabled: false, onClick: handleCheckUpdate },
    installing: { label: "安装中…", variant: "default", disabled: true, onClick: () => {} },
    disabled: { label: "不可用", variant: "default", disabled: true, onClick: () => {} },
  };

  const btn = updateBtnState[updateState] || updateBtnState.idle;

  return (
    <PageLayout>
      <PageHeader title="关于" />

      <Section>
        <SectionContent>
          {/* App info */}
          <div className="flex items-center gap-3 pb-4 mb-1 border-b border-border-subtle">
            <img className="w-10 h-10 rounded-lg" src="./icon.png" alt="VoicePaste" />
            <div>
              <p className="text-sm font-semibold text-text">VoicePaste</p>
              <p className="text-xs text-text-muted">
                语音输入工具，将语音实时转为文字并输入到任意应用
              </p>
            </div>
          </div>

          <SectionItemList>
            <SectionItem
              title="当前版本"
              action={<span className="text-sm text-text-muted font-mono">{version}</span>}
            />
            <SectionItem
              title="检查更新"
              description={statusText}
              action={
                <Button
                  size="sm"
                  variant={btn.variant}
                  onClick={btn.onClick}
                  disabled={btn.disabled}
                >
                  {btn.label}
                </Button>
              }
            />
            <SectionItem
              title="Beta 更新"
              description="接收测试版本以体验新功能（可能不稳定）"
              action={
                <Toggle
                  checked={betaUpdates}
                  onChange={(v) => {
                    setBetaUpdates(v);
                    scheduleSave({ app: { beta_updates: v } });
                  }}
                />
              }
            />
            <SectionItem
              title="开源许可"
              last
              action={
                <Button size="sm" variant="ghost" onClick={() => setLicenseOpen(true)}>
                  查看
                </Button>
              }
            />
          </SectionItemList>
        </SectionContent>
      </Section>

      <Modal open={licenseOpen} onClose={() => setLicenseOpen(false)} title="开源许可">
        <pre className="text-xs whitespace-pre-wrap font-mono">{LICENSE_TEXT}</pre>
      </Modal>
    </PageLayout>
  );
}
