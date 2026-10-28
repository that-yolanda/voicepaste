export type FeedbackType = "bug" | "feature" | "other";

export const feedbackCategories: Record<FeedbackType, [string, string][]> = {
  bug: [
    ["hotkey-recording", "ui.feedback.category.bug.hotkey_recording"],
    ["hotkey-trigger", "ui.feedback.category.bug.hotkey_trigger"],
    ["microphone", "ui.feedback.category.bug.microphone"],
    ["speech-recognition", "ui.feedback.category.bug.speech_recognition"],
    ["text-polishing", "ui.feedback.category.bug.text_polishing"],
    ["speech-model-config", "ui.feedback.category.bug.speech_model_config"],
    ["llm-config", "ui.feedback.category.bug.llm_config"],
    ["text-input", "ui.feedback.category.bug.text_input"],
    ["interface", "ui.feedback.category.bug.interface"],
    ["installation", "ui.feedback.category.bug.installation"],
    ["other-problem", "ui.feedback.category.bug.other_problem"],
  ],
  feature: [
    ["hotkeys", "ui.feedback.category.feature.hotkeys"],
    ["speech-recognition", "ui.feedback.category.feature.speech_recognition"],
    ["text-polishing", "ui.feedback.category.feature.text_polishing"],
    ["llm", "ui.feedback.category.feature.llm"],
    ["hotwords", "ui.feedback.category.feature.hotwords"],
    ["interface", "ui.feedback.category.feature.interface"],
    ["other-suggestion", "ui.feedback.category.feature.other_suggestion"],
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
  if (!draft.title.trim()) errors.title = "ui.feedback.error.title_required";
  if (!draft.description.trim()) errors.description = "ui.feedback.error.description_required";
  if (!environment.appVersion.trim()) errors.appVersion = "ui.feedback.error.app_version_required";
  if (!environment.system.trim()) errors.system = "ui.feedback.error.system_required";
  const email = draft.email.trim();
  if (email && !/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(email)) {
    errors.email = "ui.feedback.error.email_invalid";
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
