import { createHash } from "node:crypto"
import {
  attachmentError,
  feedbackCategories,
  type FeedbackType,
  feedbackLimits,
  isValidEmail as validEmail,
} from "./feedback"

type Config = {
  apiKey?: string
  from?: string
  to?: string
  siteUrl?: string
  source?: "website" | "app"
}
type Attachment = { filename: string; content: string }

class FeedbackError extends Error {
  constructor(
    public code: string,
    public status = 400
  ) {
    super(code)
  }
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function redactLog(text: string) {
  return text
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, "$1 [REDACTED]")
    .replace(
      /\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret|token)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s&,;]+)/gi,
      "$1[REDACTED]"
    )
    .replace(
      /\b(?:sk|re)_[A-Za-z0-9_-]{8,}|\bsk-[A-Za-z0-9_-]{8,}/g,
      "[REDACTED]"
    )
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/\/(Users|home)\/[^/\s]+/g, "/$1/[USER]")
    .replace(/[A-Z]:\\Users\\[^\\\s]+/gi, "C:\\Users\\[USER]")
}

async function boundedFormData(request: Request) {
  const contentType = request.headers.get("content-type") ?? ""
  if (!contentType.toLowerCase().startsWith("multipart/form-data;"))
    throw new FeedbackError("invalid_fields", 415)
  const declaredSize = Number(request.headers.get("content-length"))
  if (declaredSize > feedbackLimits.request)
    throw new FeedbackError("too_large", 413)
  if (!request.body) throw new FeedbackError("invalid_fields")
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > feedbackLimits.request) {
        await reader.cancel()
        throw new FeedbackError("too_large", 413)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  try {
    return await new Response(Buffer.concat(chunks), {
      headers: { "Content-Type": contentType },
    }).formData()
  } catch {
    throw new FeedbackError("invalid_fields")
  }
}

async function prepareAttachments(log: File | null, screenshots: File[]) {
  const attachments: Attachment[] = []
  if (log) {
    let text: string
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(
        await log.arrayBuffer()
      )
    } catch {
      throw new FeedbackError("invalid_files")
    }
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text))
      throw new FeedbackError("invalid_files")
    attachments.push({
      filename: "voicepaste-diagnostic.log",
      content: Buffer.from(redactLog(text)).toString("base64"),
    })
  }
  for (const [index, file] of screenshots.entries()) {
    const bytes = Buffer.from(await file.arrayBuffer())
    const png =
      /\.png$/i.test(file.name) &&
      bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    const jpeg =
      /\.jpe?g$/i.test(file.name) &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff
    if (!png && !jpeg) throw new FeedbackError("invalid_files")
    attachments.push({
      filename: `screenshot-${index + 1}.${png ? "png" : "jpg"}`,
      content: bytes.toString("base64"),
    })
  }
  return attachments
}

// Only the server route imports this module; credentials never enter the form bundle.
export async function handleFeedback(
  request: Request,
  config: Config,
  send: typeof fetch = fetch
) {
  const respond = (body: object, status: number) =>
    Response.json(body, {
      status,
      headers: { "Cache-Control": "no-store" },
    })
  try {
    const { apiKey, from, to, siteUrl } = config
    const fromAddress = from?.match(/<([^<>]+)>$/)?.[1] ?? from ?? ""
    if (
      !apiKey?.trim() ||
      !from ||
      /[\r\n]/.test(from) ||
      !validEmail(fromAddress) ||
      !to ||
      !validEmail(to) ||
      !siteUrl
    )
      throw new FeedbackError("unavailable", 503)
    let origin: string
    try {
      origin = new URL(siteUrl).origin
    } catch {
      throw new FeedbackError("unavailable", 503)
    }
    const forbiddenSource =
      config.source === "app"
        ? request.headers.has("origin") || request.headers.has("sec-fetch-site")
        : request.headers.get("origin") !== origin ||
          request.headers.get("sec-fetch-site") === "cross-site"
    if (forbiddenSource) throw new FeedbackError("forbidden", 403)

    const form = await boundedFormData(request)
    const allowed = new Set([
      "type",
      "category",
      "title",
      "description",
      "email",
      "wechat",
      "appVersion",
      "system",
      "submissionId",
      "log",
      "screenshots",
    ])
    for (const key of form.keys()) {
      if (
        !allowed.has(key) ||
        (key !== "screenshots" && form.getAll(key).length !== 1)
      )
        throw new FeedbackError("invalid_fields")
    }
    const field = (name: string, max: number, required = false) => {
      const value = form.get(name)
      if (value !== null && typeof value !== "string")
        throw new FeedbackError("invalid_fields")
      const text = (value ?? "").trim()
      if (
        (required && !text) ||
        text.length > max ||
        /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)
      )
        throw new FeedbackError("invalid_fields")
      return text
    }
    const type = field("type", 16, true)
    const category = field("category", 64)
    const title = field("title", feedbackLimits.title, true)
    const description = field("description", feedbackLimits.description, true)
    const email = field("email", 254)
    const wechat = field("wechat", 254)
    const appVersion = field("appVersion", 100, true)
    const system = field("system", 200, true)
    const submissionId = field("submissionId", 36, true)
    if (
      !["bug", "feature", "other"].includes(type) ||
      !uuidPattern.test(submissionId) ||
      /[\r\n]/.test(title) ||
      (email !== "" && !validEmail(email))
    )
      throw new FeedbackError("invalid_fields")

    const selectedCategory = feedbackCategories[type as FeedbackType].find(
      (option) => option.value === category
    )
    if (category && !selectedCategory) throw new FeedbackError("invalid_fields")

    const log = form.get("log")
    const screenshots = form.getAll("screenshots")
    if (
      (log !== null && typeof log === "string") ||
      screenshots.some((file) => typeof file === "string")
    )
      throw new FeedbackError("invalid_files")
    const files = screenshots as File[]
    const fileError = attachmentError(log as File | null, files)
    if (fileError)
      throw new FeedbackError(fileError, fileError === "too_large" ? 413 : 400)
    const attachments = await prepareAttachments(log as File | null, files)
    const payload = {
      from,
      to: [to],
      subject: `[VoicePaste ${type}] ${title}`,
      ...(email ? { reply_to: email } : {}),
      text: [
        `Feedback ID: ${submissionId}`,
        ...(config.source === "app" ? ["Source: VoicePaste desktop app"] : []),
        `Type: ${type}`,
        `Category: ${selectedCategory?.label.en ?? "Not specified"}`,
        `Email: ${email || "Not provided"}`,
        `WeChat: ${wechat || "Not provided"}`,
        `App version: ${appVersion || "Not provided"}`,
        `System: ${system || "Not provided"}`,
        "",
        title,
        "",
        description,
      ].join("\n"),
      ...(attachments.length ? { attachments } : {}),
    }
    // Bind the UUID to the payload as well, so a reused ID cannot conflict with another report.
    const body = JSON.stringify(payload)
    const digest = createHash("sha256").update(body).digest("hex")
    let result: Response
    try {
      result = await send("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": `feedback/${submissionId}/${digest}`,
        },
        body,
        signal: AbortSignal.timeout(15_000),
      })
      if (!result.ok) throw new Error("send rejected")
      const data = await result.json()
      if (typeof data.id !== "string" || !data.id)
        throw new Error("invalid send response")
      return respond({ ok: true, submissionId }, 202)
    } catch {
      throw new FeedbackError("send_failed", 502)
    }
  } catch (error) {
    if (error instanceof FeedbackError)
      return respond({ error: error.code }, error.status)
    return respond({ error: "send_failed" }, 502)
  }
}
