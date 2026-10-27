"use client"

import { FileText, ImagePlus, LoaderCircle, X } from "lucide-react"
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ChangeEvent,
  type FormEvent,
} from "react"
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
  AttachmentTrigger,
} from "@/components/ui/attachment"
import { Button } from "@/components/ui/button"
import { Field, FieldError, FieldLabel } from "@/components/ui/field"
import { toast } from "sonner"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  attachmentError,
  feedbackCategories,
  type FeedbackType,
  feedbackLimits,
  feedbackResponseError,
  isValidEmail,
} from "@/lib/feedback"
import { feedbackCopy } from "@/lib/feedback-copy"
import type { Locale } from "@/lib/i18n"

const controlClass =
  "w-full rounded-lg border border-input bg-background px-3 py-2.5 text-base placeholder:text-foreground/70 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 aria-invalid:border-destructive aria-invalid:ring-destructive/20"
const compactControlClass =
  "h-11 min-w-0 flex-1 rounded-lg border border-input bg-background px-3 text-sm placeholder:text-foreground/70 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 aria-invalid:border-destructive aria-invalid:ring-destructive/20"
const attachmentButtonClass =
  "size-20 shrink-0 items-center justify-center rounded-xl bg-transparent p-0 sm:size-24"

type ValidatedField =
  "title" | "description" | "appVersion" | "system" | "email"

function isValidatedField(name: string): name is ValidatedField {
  return (
    name === "title" ||
    name === "description" ||
    name === "appVersion" ||
    name === "system" ||
    name === "email"
  )
}

type ScreenshotItem = { file: File; url: string }

const subscribeToHydration = () => () => {}

function RequiredMark() {
  return (
    <span aria-hidden="true" className="ml-0.5 text-destructive">
      *
    </span>
  )
}

function fileKib(file: File) {
  return Math.max(1, Math.ceil(file.size / 1024))
}

function revokeScreenshots(items: ScreenshotItem[]) {
  for (const item of items) URL.revokeObjectURL(item.url)
}

function ScreenshotAttachment({
  item,
  label,
  onRemove,
}: {
  item: ScreenshotItem
  label: string
  onRemove: () => void
}) {
  return (
    <Attachment
      orientation="vertical"
      className="size-20 overflow-hidden rounded-xl p-0 sm:size-24"
    >
      <AttachmentMedia variant="image" className="size-full rounded-none">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={item.url} alt={item.file.name} />
      </AttachmentMedia>
      <AttachmentActions>
        <AttachmentAction
          aria-label={`${label}: ${item.file.name}`}
          title={`${label}: ${item.file.name}`}
          onClick={onRemove}
          className="size-7 rounded-full bg-background/90 text-foreground hover:bg-background"
        >
          <X />
        </AttachmentAction>
      </AttachmentActions>
    </Attachment>
  )
}

export function FeedbackForm({ locale }: { locale: Locale }) {
  const copy = feedbackCopy[locale]
  const [screenshots, setScreenshots] = useState<ScreenshotItem[]>([])
  const [log, setLog] = useState<File | null>(null)
  const [feedbackType, setFeedbackType] = useState<FeedbackType>("bug")
  const [category, setCategory] = useState("")
  const [pending, setPending] = useState(false)
  const ready = useSyncExternalStore(
    subscribeToHydration,
    () => true,
    () => false
  )
  const [fileError, setFileError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<
    Partial<Record<ValidatedField, string>>
  >({})
  const touchedFields = useRef(new Set<ValidatedField>())
  const screenshotInput = useRef<HTMLInputElement>(null)
  const logInput = useRef<HTMLInputElement>(null)
  const submissionId = useRef<string | null>(null)
  const submitting = useRef(false)
  const screenshotsRef = useRef<ScreenshotItem[]>([])

  useEffect(() => {
    screenshotsRef.current = screenshots
  }, [screenshots])

  useEffect(() => () => revokeScreenshots(screenshotsRef.current), [])

  function changed() {
    submissionId.current = null
    setFileError(null)
  }

  function fieldError(name: ValidatedField, value: string) {
    const text = value.trim()
    const valid = name === "email" ? !text || isValidEmail(text) : !!text
    return valid ? undefined : copy.validation[name]
  }

  function validateField(name: ValidatedField, value: string) {
    touchedFields.current.add(name)
    setFieldErrors((errors) => ({ ...errors, [name]: fieldError(name, value) }))
  }

  function chooseScreenshot(event: ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(event.currentTarget.files ?? [])
    event.currentTarget.value = ""
    const candidates = [
      ...screenshots,
      ...selected.map((file) => ({ file, url: URL.createObjectURL(file) })),
    ]
    const error = attachmentError(
      log,
      candidates.map((item) => item.file)
    )

    if (error) {
      revokeScreenshots(candidates.slice(screenshots.length))
      changed()
      setFileError(copy.errors[error])
      return
    }

    changed()
    setScreenshots(candidates)
  }

  function chooseLog(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ""
    if (!file) return

    const error = attachmentError(
      file,
      screenshots.map((item) => item.file)
    )
    if (error) {
      changed()
      setFileError(copy.errors[error])
      return
    }

    changed()
    setLog(file)
  }

  function removeScreenshot(item: ScreenshotItem) {
    changed()
    URL.revokeObjectURL(item.url)
    setScreenshots(screenshots.filter((current) => current !== item))
  }

  function clearLog() {
    changed()
    setLog(null)
  }

  function resetAttachments() {
    revokeScreenshots(screenshots)
    setScreenshots([])
    setLog(null)
    setFileError(null)
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting.current) return

    const form = event.currentTarget
    const data = new FormData(form)
    const errors: Partial<Record<ValidatedField, string>> = {}
    for (const name of [
      "title",
      "description",
      "appVersion",
      "system",
      "email",
    ] as const) {
      touchedFields.current.add(name)
      const error = fieldError(name, String(data.get(name) ?? ""))
      if (error) errors[name] = error
    }
    setFieldErrors(errors)
    const firstInvalid = Object.keys(errors)[0]
    if (firstInvalid) {
      const control = form.elements.namedItem(firstInvalid)
      if (control instanceof HTMLElement) control.focus()
      return
    }

    submissionId.current ??= crypto.randomUUID()
    data.set("submissionId", submissionId.current)
    if (log) data.append("log", log)
    for (const item of screenshots) data.append("screenshots", item.file)

    submitting.current = true
    setPending(true)
    try {
      const response = await fetch("/api/feedback", {
        method: "POST",
        body: data,
        signal: AbortSignal.timeout(25_000),
      })
      if (!response.ok) {
        const error = await feedbackResponseError(response)
        toast.error(copy.errors[error], {
          id: "feedback-submit",
          duration: 10_000,
        })
        return
      }

      const result = await response.json()
      if (result.ok !== true) throw new Error("Invalid submission response")
      toast.success(copy.success, { id: "feedback-submit", duration: 8_000 })
      form.reset()
      setFeedbackType("bug")
      setCategory("")
      touchedFields.current.clear()
      setFieldErrors({})
      resetAttachments()
      submissionId.current = null
    } catch {
      toast.error(copy.errors.send_failed, {
        id: "feedback-submit",
        duration: 10_000,
      })
    } finally {
      submitting.current = false
      setPending(false)
    }
  }

  const typeOptions = [
    { value: "bug", label: copy.bug },
    { value: "feature", label: copy.feature },
    { value: "other", label: copy.other },
  ] as const

  return (
    <form
      method="post"
      action="/api/feedback"
      encType="multipart/form-data"
      noValidate
      onSubmit={submit}
      onBlur={(event) => {
        const control = event.target
        if (
          (control instanceof HTMLInputElement ||
            control instanceof HTMLTextAreaElement) &&
          isValidatedField(control.name)
        )
          validateField(control.name, control.value)
      }}
      onChange={(event) => {
        const control = event.target
        if (control instanceof HTMLInputElement && control.type === "file")
          return
        changed()
        if (
          (control instanceof HTMLInputElement ||
            control instanceof HTMLTextAreaElement) &&
          isValidatedField(control.name) &&
          touchedFields.current.has(control.name)
        )
          validateField(control.name, control.value)
      }}
      aria-label={copy.heading}
      aria-busy={pending}
    >
      <fieldset disabled={!ready || pending} className="min-w-0 space-y-5">
        <div className="space-y-2">
          <span id="feedback-type-label" className="block text-sm font-medium">
            {copy.type}
            <RequiredMark />
          </span>
          <div
            role="radiogroup"
            aria-labelledby="feedback-type-label"
            className="grid grid-cols-3 gap-2"
          >
            {typeOptions.map((option) => (
              <label
                key={option.value}
                className="cursor-pointer overflow-hidden rounded-lg border border-input bg-background transition-colors has-peer-focus-visible:ring-2 has-peer-focus-visible:ring-ring has-[:checked]:border-foreground/25"
              >
                <input
                  type="radio"
                  name="type"
                  value={option.value}
                  required
                  checked={feedbackType === option.value}
                  className="peer sr-only"
                  onChange={() => {
                    setFeedbackType(option.value)
                    setCategory("")
                  }}
                />
                <span className="flex min-h-11 items-center justify-center rounded-[inherit] px-2 text-center text-sm text-foreground/70 transition-colors peer-checked:bg-muted peer-checked:font-medium peer-checked:text-foreground">
                  {option.label}
                </span>
              </label>
            ))}
          </div>
        </div>

        {feedbackCategories[feedbackType].length > 0 && (
          <Field>
            <FieldLabel htmlFor="feedback-category">{copy.category}</FieldLabel>
            <Select
              name="category"
              value={category}
              items={[
                { value: "", label: copy.categoryNone },
                ...feedbackCategories[feedbackType].map((option) => ({
                  value: option.value,
                  label: option.label[locale],
                })),
              ]}
              onValueChange={(value) => {
                setCategory(value ?? "")
                changed()
              }}
              disabled={!ready || pending}
            >
              <SelectTrigger
                id="feedback-category"
                className="h-11 w-full data-[size=default]:h-11"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="start" alignItemWithTrigger={false}>
                <SelectItem value="">{copy.categoryNone}</SelectItem>
                {feedbackCategories[feedbackType].map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label[locale]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        )}

        <Field data-invalid={!!fieldErrors.title}>
          <FieldLabel
            htmlFor="feedback-title"
            className="block text-sm font-medium"
          >
            {copy.title}
            <RequiredMark />
          </FieldLabel>
          <input
            id="feedback-title"
            name="title"
            aria-invalid={!!fieldErrors.title}
            aria-describedby={
              fieldErrors.title ? "feedback-title-error" : undefined
            }
            required
            maxLength={feedbackLimits.title}
            placeholder={copy.titleHint}
            className={controlClass}
          />
          {fieldErrors.title && (
            <FieldError id="feedback-title-error">
              {fieldErrors.title}
            </FieldError>
          )}
        </Field>

        <Field data-invalid={!!fieldErrors.description}>
          <FieldLabel
            htmlFor="feedback-description"
            className="block text-sm font-medium"
          >
            {copy.description}
            <RequiredMark />
          </FieldLabel>
          <textarea
            id="feedback-description"
            name="description"
            aria-invalid={!!fieldErrors.description}
            aria-describedby={
              fieldErrors.description ? "feedback-description-error" : undefined
            }
            required
            maxLength={feedbackLimits.description}
            rows={5}
            placeholder={copy.descriptionHint}
            className={`${controlClass} resize-y`}
          />
          {fieldErrors.description && (
            <FieldError id="feedback-description-error">
              {fieldErrors.description}
            </FieldError>
          )}
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field data-invalid={!!fieldErrors.appVersion}>
            <label
              htmlFor="feedback-version"
              className="flex min-w-0 items-center gap-3 text-sm font-medium"
            >
              <span className="w-14 shrink-0">
                {copy.version}
                <RequiredMark />
              </span>
              <input
                id="feedback-version"
                name="appVersion"
                required
                aria-invalid={!!fieldErrors.appVersion}
                aria-describedby={
                  fieldErrors.appVersion ? "feedback-version-error" : undefined
                }
                maxLength={100}
                placeholder={copy.versionHint}
                className={compactControlClass}
              />
            </label>
            {fieldErrors.appVersion && (
              <FieldError id="feedback-version-error">
                {fieldErrors.appVersion}
              </FieldError>
            )}
          </Field>
          <Field data-invalid={!!fieldErrors.system}>
            <label
              htmlFor="feedback-system"
              className="flex min-w-0 items-center gap-3 text-sm font-medium"
            >
              <span className="w-14 shrink-0">
                {copy.system}
                <RequiredMark />
              </span>
              <input
                id="feedback-system"
                name="system"
                required
                aria-invalid={!!fieldErrors.system}
                aria-describedby={
                  fieldErrors.system ? "feedback-system-error" : undefined
                }
                maxLength={200}
                placeholder={copy.systemHint}
                className={compactControlClass}
              />
            </label>
            {fieldErrors.system && (
              <FieldError id="feedback-system-error">
                {fieldErrors.system}
              </FieldError>
            )}
          </Field>
        </div>

        <div className="space-y-3">
          <div className="flex items-baseline gap-2">
            <span
              id="feedback-screenshots-label"
              className="block text-sm font-medium"
            >
              {copy.screenshots}
            </span>
            <span className="text-xs text-foreground/60">
              {copy.screenshotLimit}
            </span>
          </div>
          <input
            ref={screenshotInput}
            type="file"
            accept=".png,.jpg,.jpeg,image/png,image/jpeg"
            multiple
            aria-hidden="true"
            tabIndex={-1}
            className="sr-only"
            onChange={chooseScreenshot}
          />
          <div className="grid grid-cols-4 items-start gap-2.5 sm:flex sm:flex-wrap sm:gap-3">
            {screenshots.map((item) => (
              <ScreenshotAttachment
                key={item.url}
                item={item}
                label={copy.remove}
                onRemove={() => removeScreenshot(item)}
              />
            ))}
            {screenshots.length < feedbackLimits.screenshots && (
              <Attachment
                state="idle"
                orientation="vertical"
                className={attachmentButtonClass}
              >
                <AttachmentTrigger
                  aria-label={copy.addScreenshot}
                  title={copy.addScreenshot}
                  onClick={() => screenshotInput.current?.click()}
                />
                <AttachmentMedia className="size-full rounded-none bg-transparent">
                  <ImagePlus />
                </AttachmentMedia>
              </Attachment>
            )}
          </div>
        </div>

        <div className="space-y-3">
          <span id="feedback-log-label" className="block text-sm font-medium">
            {copy.log}
          </span>
          <input
            ref={logInput}
            type="file"
            accept=".log,.txt,text/plain"
            aria-hidden="true"
            tabIndex={-1}
            className="sr-only"
            onChange={chooseLog}
          />
          {log ? (
            <Attachment className="w-full sm:max-w-md">
              <AttachmentMedia>
                <FileText />
              </AttachmentMedia>
              <AttachmentContent>
                <AttachmentTitle className="text-foreground">
                  {log.name}
                </AttachmentTitle>
                <AttachmentDescription className="text-foreground/70">
                  {fileKib(log)} KiB
                </AttachmentDescription>
              </AttachmentContent>
              <AttachmentActions>
                <AttachmentAction
                  aria-label={`${copy.remove}: ${log.name}`}
                  onClick={clearLog}
                >
                  <X />
                </AttachmentAction>
              </AttachmentActions>
            </Attachment>
          ) : (
            <Attachment
              state="idle"
              orientation="vertical"
              className={attachmentButtonClass}
            >
              <AttachmentTrigger
                aria-label={copy.addLog}
                aria-describedby="feedback-log-help"
                title={copy.addLog}
                onClick={() => logInput.current?.click()}
              />
              <AttachmentMedia className="size-full rounded-none bg-transparent">
                <FileText />
              </AttachmentMedia>
            </Attachment>
          )}
          <div className="space-y-1.5 text-sm text-foreground/70">
            <p id="feedback-log-help">{copy.logLocation}</p>
            <p className="space-y-1 sm:flex sm:items-baseline sm:gap-2 sm:space-y-0">
              <span className="block shrink-0 font-medium text-foreground">
                macOS
              </span>
              <code className="block min-w-0 font-mono text-xs leading-5">
                ~/Library/Application Support/
                <wbr />
                com.yolanda.voicepaste/
                <wbr />
                voicepaste.log
              </code>
            </p>
            <p className="space-y-1 sm:flex sm:items-baseline sm:gap-2 sm:space-y-0">
              <span className="block shrink-0 font-medium text-foreground">
                Windows
              </span>
              <code className="block min-w-0 font-mono text-xs leading-5">
                %APPDATA%\
                <wbr />
                com.yolanda.voicepaste\
                <wbr />
                voicepaste.log
              </code>
            </p>
          </div>
        </div>

        {fileError && (
          <p role="alert" className="text-sm text-destructive">
            {fileError}
          </p>
        )}

        <Field data-invalid={!!fieldErrors.email}>
          <FieldLabel
            htmlFor="feedback-email"
            className="block text-sm font-medium"
          >
            {copy.email}
          </FieldLabel>
          <input
            id="feedback-email"
            name="email"
            aria-invalid={!!fieldErrors.email}
            aria-describedby={
              fieldErrors.email ? "feedback-email-error" : undefined
            }
            type="email"
            autoComplete="email"
            maxLength={254}
            placeholder={copy.emailHint}
            className={controlClass}
          />
          {fieldErrors.email && (
            <FieldError id="feedback-email-error">
              {fieldErrors.email}
            </FieldError>
          )}
        </Field>

        {locale === "zh" && (
          <div className="space-y-2">
            <label
              htmlFor="feedback-wechat"
              className="block text-sm font-medium"
            >
              {copy.wechat}
            </label>
            <input
              id="feedback-wechat"
              name="wechat"
              type="text"
              autoComplete="off"
              maxLength={254}
              placeholder={copy.wechatHint}
              className={controlClass}
            />
          </div>
        )}

        <div className="flex justify-center">
          <Button
            type="submit"
            disabled={!ready || pending}
            className="min-h-11 w-full px-6 text-base sm:w-auto"
          >
            {pending && (
              <LoaderCircle
                aria-hidden="true"
                className="size-4 animate-spin"
              />
            )}
            {pending ? copy.sending : copy.send}
          </Button>
        </div>
      </fieldset>
    </form>
  )
}
