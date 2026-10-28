import i18next from "i18next";
import { useEffect, useRef, useState } from "react";
import { errText } from "@/i18n/errText";
import {
  getFeedbackEnvironment,
  getFeedbackLog,
  getLogPath,
  setFeedbackDraftActive,
  submitFeedback,
} from "@/settings/bridge";
import { useToast } from "@/settings/components/Toast";
import {
  encodeScreenshot,
  type FeedbackDraft,
  type FeedbackEnvironment,
  type FeedbackField,
  type FeedbackFieldErrors,
  type FeedbackPayload,
  feedbackFields,
  validateFeedback,
} from "@/settings/lib/feedback";

const emptyDraft: FeedbackDraft = {
  type: "bug",
  category: "",
  title: "",
  description: "",
  email: "",
  wechat: "",
};
type Screenshot = { id: string; file: File; url: string };

export function useFeedback(active: boolean) {
  const [draft, setDraft] = useState<FeedbackDraft>(emptyDraft);
  const [environment, setEnvironment] = useState<FeedbackEnvironment | null>(null);
  const [environmentLoading, setEnvironmentLoading] = useState(false);
  const [system, setSystem] = useState("");
  const [appVersion, setAppVersion] = useState("");
  const [touched, setTouched] = useState<Partial<Record<FeedbackField, boolean>>>({});
  const [screenshots, setScreenshots] = useState<Screenshot[]>([]);
  const [includeLog, setIncludeLog] = useState(false);
  const [logPreview, setLogPreview] = useState<string | null>(null);
  const [readingLog, setReadingLog] = useState(false);
  const [logPath, setLogPath] = useState("");
  const [pending, setPending] = useState(false);
  const { toast, showToast } = useToast();
  const environmentRequested = useRef(false);
  const busy = useRef(false);
  const prepared = useRef<FeedbackPayload | null>(null);
  const logSnapshot = useRef<string | null>(null);
  const images = useRef(screenshots);
  images.current = screenshots;
  const dirty =
    draft.type !== "bug" ||
    !!(
      draft.title ||
      draft.description ||
      draft.email ||
      draft.wechat ||
      draft.category ||
      screenshots.length ||
      includeLog
    ) ||
    system !== (environment?.system ?? "") ||
    appVersion !== (environment?.appVersion ?? "");
  const validation = validateFeedback(draft, { system, appVersion });
  const fieldErrors: FeedbackFieldErrors = {};
  for (const field of feedbackFields) {
    if (touched[field] && validation[field]) fieldErrors[field] = validation[field];
  }

  useEffect(() => {
    void setFeedbackDraftActive(dirty || pending).catch(() => {});
  }, [dirty, pending]);

  useEffect(() => {
    if (!active || environmentRequested.current) return;
    environmentRequested.current = true;
    getLogPath()
      .then(setLogPath)
      .catch(() => setLogPath("无法读取日志路径"));
    setEnvironmentLoading(true);
    getFeedbackEnvironment()
      .then((value) => {
        setEnvironment(value);
        setSystem(value.system);
        setAppVersion(value.appVersion);
      })
      .catch(() => {})
      .finally(() => setEnvironmentLoading(false));
  }, [active]);

  useEffect(
    () => () => {
      for (const image of images.current) URL.revokeObjectURL(image.url);
    },
    [],
  );

  function changed() {
    prepared.current = null;
  }

  function clear() {
    changed();
    setDraft(emptyDraft);
    setSystem(environment?.system ?? "");
    setAppVersion(environment?.appVersion ?? "");
    setTouched({});
    for (const image of screenshots) URL.revokeObjectURL(image.url);
    setScreenshots([]);
    setIncludeLog(false);
    setLogPreview(null);
    logSnapshot.current = null;
  }

  function change<K extends keyof FeedbackDraft>(key: K, value: FeedbackDraft[K]) {
    changed();
    setDraft((previous) => ({
      ...previous,
      [key]: value,
      ...(key === "type" ? { category: "" } : {}),
    }));
  }

  function fail(message: string) {
    showToast(message, "error");
  }

  function addScreenshots(files: File[]) {
    const next = [...screenshots.map((item) => item.file), ...files];
    if (next.length > 4 || next.some((file) => !/\.(png|jpe?g)$/i.test(file.name) || !file.size)) {
      fail(i18next.t("errors.feedback.invalid_files"));
      return;
    }
    if (
      next.some((file) => file.size > 2 * 1024 * 1024) ||
      next.reduce((sum, file) => sum + file.size, 0) > 3 * 1024 * 1024
    ) {
      fail(i18next.t("errors.feedback.too_large"));
      return;
    }
    changed();
    setScreenshots([
      ...screenshots,
      ...files.map((file) => ({ id: crypto.randomUUID(), file, url: URL.createObjectURL(file) })),
    ]);
  }

  function removeScreenshot(id: string) {
    changed();
    const image = screenshots.find((item) => item.id === id);
    if (image) URL.revokeObjectURL(image.url);
    setScreenshots(screenshots.filter((item) => item.id !== id));
  }

  async function previewLog() {
    if (readingLog || pending) return;
    setReadingLog(true);
    try {
      logSnapshot.current ??= await getFeedbackLog();
      setLogPreview(logSnapshot.current);
    } catch {
      fail(i18next.t("errors.feedback.log_unavailable"));
    } finally {
      setReadingLog(false);
    }
  }

  async function submit() {
    if (busy.current || readingLog) return;
    const firstInvalid = feedbackFields.find((field) => validation[field]);
    if (firstInvalid) {
      setTouched(Object.fromEntries(feedbackFields.map((field) => [field, true])));
      document
        .getElementById(`feedback-${firstInvalid === "appVersion" ? "version" : firstInvalid}`)
        ?.focus();
      return;
    }
    busy.current = true;
    setPending(true);
    try {
      // Preserve the exact attachments and UUID when a timed-out request is retried.
      if (!prepared.current) {
        if (includeLog) logSnapshot.current ??= await getFeedbackLog();
        prepared.current = {
          ...draft,
          system,
          appVersion,
          submissionId: crypto.randomUUID(),
          log: includeLog ? logSnapshot.current : null,
          screenshots: await Promise.all(screenshots.map((image) => encodeScreenshot(image.file))),
        };
      }
      await submitFeedback(prepared.current);
      clear();
      showToast("反馈已提交，感谢你的帮助！");
    } catch (reason) {
      fail(errText(reason));
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  return {
    draft,
    change,
    environment,
    environmentLoading,
    system,
    appVersion,
    changeAppVersion: (value: string) => {
      changed();
      setAppVersion(value);
    },
    touch: (field: FeedbackField) => setTouched((previous) => ({ ...previous, [field]: true })),
    fieldErrors,
    changeSystem: (value: string) => {
      changed();
      setSystem(value);
    },
    screenshots,
    addScreenshots,
    removeScreenshot,
    includeLog,
    toggleLog: (value: boolean) => {
      changed();
      logSnapshot.current = null;
      setIncludeLog(value);
    },
    logPreview,
    logPath,
    closePreview: () => setLogPreview(null),
    previewLog,
    readingLog,
    pending,
    toast,
    submit,
    clear,
    dirty,
  };
}
