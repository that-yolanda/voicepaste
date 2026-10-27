export type FeedbackType = "bug" | "feature" | "other"

type FeedbackCategory = {
  value: string
  label: { en: string; zh: string }
}

export const feedbackCategories: Record<FeedbackType, FeedbackCategory[]> = {
  bug: [
    {
      value: "hotkey-recording",
      label: { en: "Shortcut recording", zh: "快捷键录制" },
    },
    {
      value: "hotkey-trigger",
      label: { en: "Shortcut triggering", zh: "快捷键触发" },
    },
    {
      value: "microphone",
      label: { en: "Microphone & recording", zh: "麦克风与录音" },
    },
    {
      value: "speech-recognition",
      label: { en: "Speech recognition", zh: "语音识别" },
    },
    {
      value: "text-polishing",
      label: { en: "Text polishing", zh: "文本润色" },
    },
    {
      value: "speech-model-config",
      label: { en: "Speech model setup", zh: "语音模型配置" },
    },
    {
      value: "llm-config",
      label: { en: "Language model setup", zh: "大语言模型配置" },
    },
    { value: "text-input", label: { en: "Text input", zh: "文字输入" } },
    {
      value: "interface",
      label: { en: "Overlay & interface", zh: "悬浮窗与界面" },
    },
    {
      value: "installation",
      label: { en: "Installation, startup & updates", zh: "安装、启动与更新" },
    },
    { value: "other-problem", label: { en: "Other problem", zh: "其他问题" } },
  ],
  feature: [
    { value: "hotkeys", label: { en: "Shortcuts", zh: "快捷键" } },
    {
      value: "speech-recognition",
      label: { en: "Speech recognition", zh: "语音识别" },
    },
    {
      value: "text-polishing",
      label: { en: "Text polishing", zh: "文本润色" },
    },
    { value: "llm", label: { en: "Language models", zh: "大语言模型" } },
    { value: "hotwords", label: { en: "Hotwords", zh: "热词库" } },
    { value: "interface", label: { en: "Interface", zh: "界面" } },
    {
      value: "other-suggestion",
      label: { en: "Other suggestion", zh: "其他建议" },
    },
  ],
  other: [],
}

export function isValidEmail(value: string) {
  return (
    value.length <= 254 &&
    !/[\x00-\x1f\x7f]/.test(value) &&
    /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(value)
  )
}

export const feedbackLimits = {
  title: 120,
  description: 10_000,
  log: 512 * 1024,
  screenshot: 2 * 1024 * 1024,
  screenshots: 4,
  attachments: 3 * 1024 * 1024,
  request: 3.5 * 1024 * 1024,
} as const

export type FeedbackErrorCode =
  | "invalid_fields"
  | "invalid_files"
  | "too_large"
  | "forbidden"
  | "unavailable"
  | "send_failed"
  | "rate_limited"

export function attachmentError(
  log: File | null,
  screenshots: File[]
): FeedbackErrorCode | null {
  if (
    (log && (!/\.(log|txt)$/i.test(log.name) || log.size === 0)) ||
    screenshots.length > feedbackLimits.screenshots ||
    screenshots.some(
      (file) => !/\.(png|jpe?g)$/i.test(file.name) || file.size === 0
    )
  )
    return "invalid_files"
  if (
    (log && log.size > feedbackLimits.log) ||
    screenshots.some((file) => file.size > feedbackLimits.screenshot) ||
    (log?.size ?? 0) + screenshots.reduce((sum, file) => sum + file.size, 0) >
      feedbackLimits.attachments
  )
    return "too_large"
  return null
}

export async function feedbackResponseError(
  response: Response
): Promise<FeedbackErrorCode> {
  if (response.status === 429) return "rate_limited"
  if (response.status === 413) return "too_large"
  try {
    const data = await response.json()
    const codes: FeedbackErrorCode[] = [
      "invalid_fields",
      "invalid_files",
      "too_large",
      "forbidden",
      "unavailable",
      "send_failed",
      "rate_limited",
    ]
    if (codes.includes(data?.error)) return data.error
  } catch {
    // Platform errors may be HTML or plain text.
  }
  return "send_failed"
}
