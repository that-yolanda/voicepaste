import { ImagePlus, LoaderCircle, X } from "lucide-react";
import { useRef } from "react";
import { Button } from "@/settings/components/Button";
import { Input } from "@/settings/components/Input";
import { Modal } from "@/settings/components/Modal";
import { SegmentedControl } from "@/settings/components/SegmentedControl";
import { Select } from "@/settings/components/Select";
import { Textarea } from "@/settings/components/Textarea";
import { Toggle } from "@/settings/components/Toggle";
import type { useFeedback } from "@/settings/hooks/useFeedback";
import {
  PageHeader,
  PageLayout,
  Section,
  SectionContent,
  SectionItem,
  SectionItemList,
} from "@/settings/layout/PageLayout";
import { type FeedbackType, feedbackCategories } from "@/settings/lib/feedback";

function FieldError({ name, message }: { name: string; message?: string }) {
  return message ? (
    <p id={`feedback-${name}-error`} role="alert" className="text-xs text-error">
      {message}
    </p>
  ) : null;
}

export function FeedbackPage({ feedback: f }: { feedback: ReturnType<typeof useFeedback> }) {
  const screenshotInput = useRef<HTMLInputElement>(null);
  return (
    <PageLayout>
      <PageHeader
        title="问题与建议"
        description="告诉我们你遇到的问题，或希望 VoicePaste 带来的改进。"
      />
      <form
        noValidate
        aria-busy={f.pending}
        onSubmit={(event) => {
          event.preventDefault();
          void f.submit();
        }}
      >
        <fieldset disabled={f.pending || f.readingLog} className="min-w-0">
          <Section>
            <SectionContent>
              <SectionItemList>
                <SectionItem
                  title="类型"
                  className="shrink-0"
                  action={
                    <fieldset aria-label="类型">
                      <SegmentedControl
                        options={[
                          { value: "bug", label: "问题" },
                          { value: "feature", label: "需求建议" },
                          { value: "other", label: "其他" },
                        ]}
                        value={f.draft.type}
                        onChange={(value) => f.change("type", value as FeedbackType)}
                      />
                    </fieldset>
                  }
                />
                {f.draft.type !== "other" && (
                  <SectionItem
                    title="涉及模块"
                    htmlFor="feedback-category"
                    action={
                      <Select
                        id="feedback-category"
                        value={f.draft.category}
                        onChange={(value) => f.change("category", value)}
                        options={[
                          { value: "", label: "暂不选择" },
                          ...feedbackCategories[f.draft.type].map(([value, label]) => ({
                            value,
                            label,
                          })),
                        ]}
                      />
                    }
                  />
                )}
                <SectionItem
                  title="标题 *"
                  htmlFor="feedback-title"
                  action={
                    <div className="w-full">
                      <Input
                        id="feedback-title"
                        required
                        aria-invalid={!!f.fieldErrors.title}
                        aria-describedby={f.fieldErrors.title ? "feedback-title-error" : undefined}
                        onBlur={() => f.touch("title")}
                        maxLength={120}
                        placeholder="一句话概括"
                        value={f.draft.title}
                        onChange={(value) => f.change("title", value)}
                      />
                      <FieldError name="title" message={f.fieldErrors.title} />
                    </div>
                  }
                />
                <SectionItem title="详细描述 *" htmlFor="feedback-description">
                  <Textarea
                    id="feedback-description"
                    required
                    aria-invalid={!!f.fieldErrors.description}
                    aria-describedby={
                      f.fieldErrors.description ? "feedback-description-error" : undefined
                    }
                    onBlur={() => f.touch("description")}
                    maxLength={10_000}
                    rows={5}
                    placeholder="发生了什么？你期望的结果是什么？"
                    value={f.draft.description}
                    onChange={(value) => f.change("description", value)}
                  />
                  <FieldError name="description" message={f.fieldErrors.description} />
                </SectionItem>
                <SectionItem
                  title="App 版本"
                  htmlFor="feedback-version"
                  action={
                    <div className="w-full">
                      <Input
                        id="feedback-version"
                        required
                        maxLength={100}
                        value={f.appVersion}
                        disabled={f.environmentLoading}
                        aria-invalid={!!f.fieldErrors.appVersion}
                        aria-describedby={
                          f.fieldErrors.appVersion ? "feedback-version-error" : undefined
                        }
                        onBlur={() => f.touch("appVersion")}
                        onChange={f.changeAppVersion}
                        placeholder={f.environmentLoading ? "读取中…" : "例如 2.1.5"}
                      />
                      <FieldError name="version" message={f.fieldErrors.appVersion} />
                    </div>
                  }
                />
                <SectionItem
                  title="系统版本"
                  htmlFor="feedback-system"
                  action={
                    <div className="w-full">
                      <Input
                        id="feedback-system"
                        required
                        aria-invalid={!!f.fieldErrors.system}
                        aria-describedby={
                          f.fieldErrors.system ? "feedback-system-error" : undefined
                        }
                        onBlur={() => f.touch("system")}
                        maxLength={200}
                        value={f.system}
                        disabled={f.environmentLoading}
                        onChange={f.changeSystem}
                        placeholder={
                          f.environmentLoading ? "读取中…" : "例如 Windows 11 或 macOS 15"
                        }
                      />
                      <FieldError name="system" message={f.fieldErrors.system} />
                    </div>
                  }
                />
                <SectionItem title={`截图 ${f.screenshots.length}/4`}>
                  <div className="flex flex-wrap gap-2">
                    {f.screenshots.map((image, index) => (
                      <div
                        key={image.id}
                        className="relative h-20 w-20 overflow-hidden rounded-lg border border-border"
                      >
                        <img
                          src={image.url}
                          alt={`截图 ${index + 1}`}
                          className="h-full w-full object-cover"
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          title={`移除截图 ${index + 1}`}
                          className="absolute right-0.5 top-0.5 bg-surface-card"
                          onClick={() => f.removeScreenshot(image.id)}
                        >
                          <X size={12} aria-hidden="true" />
                        </Button>
                      </div>
                    ))}
                    {f.screenshots.length < 4 && (
                      <Button
                        variant="default"
                        size="icon"
                        title="添加截图"
                        className="h-20 w-20 border-dashed"
                        onClick={() => screenshotInput.current?.click()}
                      >
                        <ImagePlus size={22} aria-hidden="true" />
                      </Button>
                    )}
                  </div>
                  <input
                    ref={screenshotInput}
                    type="file"
                    accept="image/png,image/jpeg,.png,.jpg,.jpeg"
                    multiple
                    hidden
                    onChange={(event) => {
                      f.addScreenshots(Array.from(event.target.files ?? []));
                      event.target.value = "";
                    }}
                  />
                </SectionItem>
                <SectionItem
                  title="附件运行日志"
                  tooltip={`仅用于问题排查，不附带配置文件、录音或输入历史，也不会主动收集 API Key 等配置凭证。\n\n日志路径：${f.logPath || "读取中…"}`}
                  action={
                    <div className="flex items-center gap-2">
                      {f.includeLog && (
                        <Button variant="ghost" size="sm" onClick={() => void f.previewLog()}>
                          查看日志
                        </Button>
                      )}
                      <Toggle
                        aria-label="附件运行日志"
                        checked={f.includeLog}
                        onChange={f.toggleLog}
                      />
                    </div>
                  }
                />
                <SectionItem
                  title="邮箱"
                  htmlFor="feedback-email"
                  action={
                    <div className="w-full">
                      <Input
                        id="feedback-email"
                        aria-invalid={!!f.fieldErrors.email}
                        aria-describedby={f.fieldErrors.email ? "feedback-email-error" : undefined}
                        onBlur={() => f.touch("email")}
                        type="email"
                        autoComplete="email"
                        maxLength={254}
                        placeholder="用于回复的邮箱"
                        value={f.draft.email}
                        onChange={(value) => f.change("email", value)}
                      />
                      <FieldError name="email" message={f.fieldErrors.email} />
                    </div>
                  }
                />
                <SectionItem
                  title="微信号"
                  htmlFor="feedback-wechat"
                  last
                  action={
                    <Input
                      id="feedback-wechat"
                      className="w-full"
                      maxLength={254}
                      value={f.draft.wechat}
                      onChange={(value) => f.change("wechat", value)}
                    />
                  }
                />
              </SectionItemList>
              <div className="flex justify-end gap-2">
                {f.dirty && (
                  <Button variant="ghost" onClick={f.clear}>
                    清空反馈
                  </Button>
                )}
                <Button type="submit" variant="accent" disabled={f.environmentLoading}>
                  {f.pending && (
                    <LoaderCircle
                      size={16}
                      className="animate-spin motion-reduce:animate-none"
                      aria-hidden="true"
                    />
                  )}
                  {f.pending ? "正在提交…" : "提交反馈"}
                </Button>
              </div>
            </SectionContent>
          </Section>
        </fieldset>
      </form>
      <Modal open={f.logPreview !== null} onClose={f.closePreview} title="将发送的运行日志">
        <pre className="max-h-[55vh] whitespace-pre-wrap break-all text-xs" role="document">
          {f.logPreview}
        </pre>
      </Modal>
    </PageLayout>
  );
}
