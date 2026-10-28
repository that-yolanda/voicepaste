export type FeedbackType = "bug" | "feature" | "other";

export const feedbackCategories: Record<FeedbackType, [string, string][]> = {
  bug: [
    ["hotkey-recording", "快捷键录制"],
    ["hotkey-trigger", "快捷键触发"],
    ["microphone", "麦克风与录音"],
    ["speech-recognition", "语音识别"],
    ["text-polishing", "文本润色"],
    ["speech-model-config", "语音模型配置"],
    ["llm-config", "大语言模型配置"],
    ["text-input", "文字输入"],
    ["interface", "悬浮窗与界面"],
    ["installation", "安装、启动与更新"],
    ["other-problem", "其他问题"],
  ],
  feature: [
    ["hotkeys", "快捷键"],
    ["speech-recognition", "语音识别"],
    ["text-polishing", "文本润色"],
    ["llm", "大语言模型"],
    ["hotwords", "热词库"],
    ["interface", "界面"],
    ["other-suggestion", "其他建议"],
  ],
  other: [],
};

export interface FeedbackDraft {
  type: FeedbackType;
  category: string;
  title: string;
  description: string;
  email: string;
  wechat: string;
}

export interface FeedbackEnvironment {
  appVersion: string;
  system: string;
}
export interface FeedbackPayload extends FeedbackDraft, FeedbackEnvironment {
  submissionId: string;
  log: string | null;
  screenshots: { name: string; content: string }[];
}

export const feedbackFields = ["title", "description", "appVersion", "system", "email"] as const;
export type FeedbackField = (typeof feedbackFields)[number];
export type FeedbackFieldErrors = Partial<Record<FeedbackField, string>>;

export function validateFeedback(
  draft: FeedbackDraft,
  environment: FeedbackEnvironment,
): FeedbackFieldErrors {
  const errors: FeedbackFieldErrors = {};
  if (!draft.title.trim()) errors.title = "请输入标题。";
  if (!draft.description.trim()) errors.description = "请填写问题描述或建议。";
  if (!environment.appVersion.trim()) errors.appVersion = "请填写 App 版本。";
  if (!environment.system.trim()) errors.system = "请填写操作系统版本。";
  const email = draft.email.trim();
  if (email && !/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(email)) {
    errors.email = "请输入有效的邮箱地址，或留空。";
  }
  return errors;
}

export function encodeScreenshot(file: File): Promise<{ name: string; content: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject("invalid_files");
    reader.onload = () =>
      resolve({ name: file.name, content: String(reader.result).split(",")[1] });
    reader.readAsDataURL(file);
  });
}
