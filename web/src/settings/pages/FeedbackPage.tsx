import { ImagePlus, LoaderCircle, X } from "lucide-react";
import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/settings/components/Button";
import { Input } from "@/settings/components/Input";
import { Modal } from "@/settings/components/Modal";
import { SegmentedControl } from "@/settings/components/SegmentedControl";
import { Select } from "@/settings/components/Select";
import { Textarea } from "@/settings/components/Textarea";
import { Toggle } from "@/settings/components/Toggle";
import type { useFeedback } from "@/settings/hooks/useFeedback";
import {
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
  const { t } = useTranslation();
  const screenshotInput = useRef<HTMLInputElement>(null);
  return (
    <PageLayout>
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
                  title={t("ui.feedback.type_label")}
                  className="shrink-0"
                  action={
                    <fieldset aria-label={t("ui.feedback.type_label")}>
                      <SegmentedControl
                        options={[
                          { value: "bug", label: t("ui.feedback.type.bug") },
                          { value: "feature", label: t("ui.feedback.type.feature") },
                          { value: "other", label: t("ui.feedback.type.other") },
                        ]}
                        value={f.draft.type}
                        onChange={(value) => f.change("type", value as FeedbackType)}
                      />
                    </fieldset>
                  }
                />
                {f.draft.type !== "other" && (
                  <SectionItem
                    title={t("ui.feedback.module")}
                    htmlFor="feedback-category"
                    action={
                      <Select
                        id="feedback-category"
                        value={f.draft.category}
                        onChange={(value) => f.change("category", value)}
                        options={[
                          { value: "", label: t("ui.feedback.module_none") },
                          ...feedbackCategories[f.draft.type].map(([value, label]) => ({
                            value,
                            label: t(label),
                          })),
                        ]}
                      />
                    }
                  />
                )}
                <SectionItem
                  title={t("ui.feedback.title_field")}
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
                        placeholder={t("ui.feedback.title_placeholder")}
                        value={f.draft.title}
                        onChange={(value) => f.change("title", value)}
                      />
                      <FieldError name="title" message={f.fieldErrors.title} />
                    </div>
                  }
                />
                <SectionItem
                  title={t("ui.feedback.description_field")}
                  htmlFor="feedback-description"
                >
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
                    placeholder={t("ui.feedback.description_placeholder")}
                    value={f.draft.description}
                    onChange={(value) => f.change("description", value)}
                  />
                  <FieldError name="description" message={f.fieldErrors.description} />
                </SectionItem>
                <SectionItem
                  title={t("ui.feedback.app_version")}
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
                        placeholder={
                          f.environmentLoading
                            ? t("ui.feedback.reading")
                            : t("ui.feedback.version_placeholder")
                        }
                      />
                      <FieldError name="version" message={f.fieldErrors.appVersion} />
                    </div>
                  }
                />
                <SectionItem
                  title={t("ui.feedback.system")}
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
                          f.environmentLoading
                            ? t("ui.feedback.reading")
                            : t("ui.feedback.system_placeholder")
                        }
                      />
                      <FieldError name="system" message={f.fieldErrors.system} />
                    </div>
                  }
                />
                <SectionItem
                  title={t("ui.feedback.screenshot_count", { count: f.screenshots.length })}
                >
                  <div className="flex flex-wrap gap-2">
                    {f.screenshots.map((image, index) => (
                      <div
                        key={image.id}
                        className="relative h-20 w-20 overflow-hidden rounded-lg border border-border"
                      >
                        <img
                          src={image.url}
                          alt={t("ui.feedback.screenshot_alt", { index: index + 1 })}
                          className="h-full w-full object-cover"
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          title={t("ui.feedback.remove_screenshot", { index: index + 1 })}
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
                        title={t("ui.feedback.add_screenshot")}
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
                  title={t("ui.feedback.attach_log")}
                  tooltip={t("ui.feedback.log_tooltip", {
                    path: f.logPath || t("ui.feedback.reading"),
                  })}
                  action={
                    <div className="flex items-center gap-2">
                      {f.includeLog && (
                        <Button variant="ghost" size="sm" onClick={() => void f.previewLog()}>
                          {t("ui.feedback.view_log")}
                        </Button>
                      )}
                      <Toggle
                        aria-label={t("ui.feedback.attach_log")}
                        checked={f.includeLog}
                        onChange={f.toggleLog}
                      />
                    </div>
                  }
                />
                <SectionItem
                  title={t("ui.feedback.email")}
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
                        placeholder={t("ui.feedback.email_placeholder")}
                        value={f.draft.email}
                        onChange={(value) => f.change("email", value)}
                      />
                      <FieldError name="email" message={f.fieldErrors.email} />
                    </div>
                  }
                />
                <SectionItem
                  title={t("ui.feedback.wechat")}
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
              <div className="flex justify-center gap-2">
                {f.dirty && (
                  <Button variant="ghost" onClick={f.clear}>
                    {t("ui.feedback.clear")}
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
                  {f.pending ? t("ui.feedback.submitting") : t("ui.feedback.submit")}
                </Button>
              </div>
            </SectionContent>
          </Section>
        </fieldset>
      </form>
      <Modal
        open={f.logPreview !== null}
        onClose={f.closePreview}
        title={t("ui.feedback.log_modal_title")}
      >
        <pre className="max-h-[55vh] whitespace-pre-wrap break-all text-xs" role="document">
          {f.logPreview}
        </pre>
      </Modal>
    </PageLayout>
  );
}
