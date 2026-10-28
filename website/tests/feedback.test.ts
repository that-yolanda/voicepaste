import { strict as assert } from "node:assert"
import { randomUUID } from "node:crypto"
import { test } from "node:test"
import { handleFeedback, redactLog } from "../lib/feedback-server"
import {
  attachmentError,
  feedbackLimits,
  feedbackResponseError,
} from "../lib/feedback"

const config = {
  apiKey: "test-key-not-a-real-credential",
  from: "VoicePaste Feedback <feedback@example.test>",
  to: "owner@example.test",
  siteUrl: "https://example.test",
}
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII=",
  "base64"
)
function form() {
  const data = new FormData()
  for (const [key, value] of Object.entries({
    type: "bug",
    title: "Hotkey does not start recording",
    description: "Steps and expected behaviour.",
    submissionId: randomUUID(),
    appVersion: "2.1.5",
    system: "Windows 11",
  }))
    data.set(key, value)
  return data
}
function request(data = form(), origin: string | null = config.siteUrl) {
  return new Request(`${config.siteUrl}/api/feedback`, {
    method: "POST",
    body: data,
    headers: origin ? { origin } : {},
  })
}
function mockSender() {
  const calls: { url: string; options: RequestInit }[] = []
  const send: typeof fetch = async (url, options) => {
    calls.push({ url: String(url), options: options! })
    return Response.json({ id: "test-email-id" })
  }
  return { calls, send }
}

test("native App submissions reuse delivery without accepting browser origins", async () => {
  const mock = mockSender()
  const result = await handleFeedback(
    request(form(), null),
    { ...config, source: "app" },
    mock.send
  )
  assert.equal(result.status, 202)
  const payload = JSON.parse(mock.calls[0].options.body as string)
  assert.match(payload.text, /Source: VoicePaste desktop app/)
  assert.equal(payload.attachments, undefined)
  for (const req of [
    request(),
    new Request(`${config.siteUrl}/api/feedback/app`, {
      method: "POST",
      body: form(),
      headers: { "sec-fetch-site": "cross-site" },
    }),
  ]) {
    const rejected = await handleFeedback(
      req,
      { ...config, source: "app" },
      mock.send
    )
    assert.equal(rejected.status, 403)
  }
  assert.equal(mock.calls.length, 1)
})
async function rejected(data: FormData, status: number, code: string) {
  const mock = mockSender()
  const result = await handleFeedback(request(data), config, mock.send)
  assert.equal(result.status, status)
  assert.deepEqual(await result.json(), { error: code })
  assert.equal(mock.calls.length, 0)
}

test("sends only to the configured recipient with optional Reply-To, redacted log and safe filenames", async () => {
  const data = form()
  data.set("email", "visitor@example.test")
  data.set(
    "log",
    new File(
      [
        'api_key="private-secret"\n/Users/alice/app/file\nAuthorization: Bearer abcdef',
      ],
      "private-alice.log"
    )
  )
  data.append(
    "screenshots",
    new File([png], "private-name.png", { type: "image/png" })
  )
  const mock = mockSender()
  const response = await handleFeedback(request(data), config, mock.send)
  assert.equal(response.status, 202)
  assert.equal(response.headers.get("cache-control"), "no-store")
  assert.equal(mock.calls[0].url, "https://api.resend.com/emails")
  const payload = JSON.parse(mock.calls[0].options.body as string)
  assert.deepEqual(payload.to, [config.to])
  assert.equal(payload.from, config.from)
  assert.equal(payload.reply_to, "visitor@example.test")
  assert.match(payload.text, /Windows 11/)
  assert.equal(payload.attachments[0].filename, "voicepaste-diagnostic.log")
  assert.equal(payload.attachments[1].filename, "screenshot-1.png")
  const log = Buffer.from(payload.attachments[0].content, "base64").toString()
  assert.doesNotMatch(log, /private-secret|alice|abcdef/)
  assert.ok(Buffer.from(payload.attachments[1].content, "base64").equals(png))
})

test("email, WeChat, locale and attachments are not required", async () => {
  const mock = mockSender()
  assert.equal((await handleFeedback(request(), config, mock.send)).status, 202)
  const payload = JSON.parse(mock.calls[0].options.body as string)
  assert.equal(payload.reply_to, undefined)
  assert.equal(payload.attachments, undefined)
})

test("accepts a WeChat contact without using it as Reply-To", async () => {
  const data = form()
  data.set("wechat", "wxid_voicepaste")
  const mock = mockSender()
  assert.equal(
    (await handleFeedback(request(data), config, mock.send)).status,
    202
  )
  const payload = JSON.parse(mock.calls[0].options.body as string)
  assert.equal(payload.reply_to, undefined)
  assert.match(payload.text, /WeChat: wxid_voicepaste/)
})

test("includes a selected module in mail and keeps categories optional", async () => {
  for (const [type, category, label] of [
    ["bug", "speech-model-config", "Speech model setup"],
    ["bug", "llm-config", "Language model setup"],
    ["feature", "llm", "Language models"],
    ["feature", "hotwords", "Hotwords"],
    ["other", "", "Not specified"],
  ]) {
    const data = form()
    data.set("type", type)
    data.set("category", category)
    const mock = mockSender()
    assert.equal(
      (await handleFeedback(request(data), config, mock.send)).status,
      202
    )
    const payload = JSON.parse(mock.calls[0].options.body as string)
    assert.ok(payload.text.includes(`Category: ${label}`))
  }
})

test("rejects unknown modules and modules belonging to another feedback type", async () => {
  for (const [type, category] of [
    ["bug", "unknown"],
    ["bug", "hotwords"],
    ["feature", "speech-model-config"],
    ["other", "interface"],
  ]) {
    const data = form()
    data.set("type", type)
    data.set("category", category)
    await rejected(data, 400, "invalid_fields")
  }
  const duplicate = form()
  duplicate.append("category", "llm-config")
  duplicate.append("category", "speech-model-config")
  await rejected(duplicate, 400, "invalid_fields")
})

test("same submission produces identical payload and idempotency key across retries", async () => {
  const data = form()
  const mock = mockSender()
  await handleFeedback(request(data), config, mock.send)
  await handleFeedback(request(data), config, mock.send)
  assert.equal(mock.calls[0].options.body, mock.calls[1].options.body)
  const headers = (index: number) =>
    new Headers(mock.calls[index].options.headers)
  assert.equal(
    headers(0).get("Idempotency-Key"),
    headers(1).get("Idempotency-Key")
  )
  data.set("description", "Changed feedback")
  await handleFeedback(request(data), config, mock.send)
  assert.notEqual(
    headers(0).get("Idempotency-Key"),
    headers(2).get("Idempotency-Key")
  )
})

test("rejects missing, whitespace, excessive, duplicated and injected fields", async () => {
  for (const mutate of [
    (d: FormData) => d.delete("description"),
    (d: FormData) => d.delete("appVersion"),
    (d: FormData) => d.set("appVersion", "   "),
    (d: FormData) => d.set("appVersion", "x".repeat(101)),
    (d: FormData) => d.delete("system"),
    (d: FormData) => d.set("system", "   "),
    (d: FormData) => d.set("system", "x".repeat(201)),
    (d: FormData) => d.set("title", "   "),
    (d: FormData) => d.set("title", "x".repeat(121)),
    (d: FormData) => d.set("description", "x".repeat(10_001)),
    (d: FormData) => d.set("type", "unknown"),
    (d: FormData) => d.set("locale", "fr"),
    (d: FormData) => d.set("submissionId", "invalid"),
    (d: FormData) =>
      d.set("email", "bad@example.test\r\nBcc: spam@example.test"),
    (d: FormData) => d.set("title", "Subject\nBcc: bad"),
    (d: FormData) => d.set("to", "attacker@example.test"),
    (d: FormData) => d.set("attachmentUrl", "https://example.test/file"),
    (d: FormData) => d.append("title", "duplicate"),
  ]) {
    const data = form()
    mutate(data)
    await rejected(data, 400, "invalid_fields")
  }
})

test("validates optional email independently of unrestricted WeChat text", async () => {
  for (const email of ["", "visitor@example.test"]) {
    const data = form()
    data.set("email", email)
    data.set("wechat", "微信 联系方式 123")
    const mock = mockSender()
    assert.equal(
      (await handleFeedback(request(data), config, mock.send)).status,
      202
    )
    const payload = JSON.parse(mock.calls[0].options.body as string)
    assert.equal(payload.reply_to, email || undefined)
    assert.match(payload.text, /WeChat: 微信 联系方式 123/)
    assert.doesNotMatch(payload.text, /Language:/)
  }
  const empty = form()
  empty.set("email", "")
  empty.set("wechat", "")
  const mock = mockSender()
  assert.equal(
    (await handleFeedback(request(empty), config, mock.send)).status,
    202
  )
  const invalid = form()
  invalid.set("email", "not-an-email")
  invalid.set("wechat", "wxid_voicepaste")
  await rejected(invalid, 400, "invalid_fields")
})

test("rejects cross-origin and missing-origin requests before sending", async () => {
  for (const origin of [null, "https://evil.example.test", "null"]) {
    const mock = mockSender()
    assert.equal(
      (await handleFeedback(request(form(), origin), config, mock.send)).status,
      403
    )
    assert.equal(mock.calls.length, 0)
  }
})

test("missing or invalid configuration cannot report success or send mail", async () => {
  for (const invalid of [
    { ...config, apiKey: "" },
    { ...config, to: "" },
    { ...config, from: "" },
    { ...config, to: "private-value" },
    { ...config, siteUrl: "invalid" },
  ]) {
    const mock = mockSender()
    assert.equal(
      (await handleFeedback(request(), invalid, mock.send)).status,
      503
    )
    assert.equal(mock.calls.length, 0)
  }
})

test("rejects binary, invalid UTF-8, empty and disguised attachments", async () => {
  for (const [name, content] of [
    ["file.log", new Uint8Array([0, 1, 2])],
    ["file.txt", new Uint8Array([0xff, 0xfe, 0xff])],
    ["empty.log", ""],
    ["config.yaml", "key: secret"],
    ["archive.gz", "binary"],
  ] as const) {
    const data = form()
    data.set("log", new File([content], name))
    await rejected(data, 400, "invalid_files")
  }
  const data = form()
  data.set(
    "screenshots",
    new File(["not an image"], "fake.png", { type: "image/png" })
  )
  await rejected(data, 400, "invalid_files")
  data.set("screenshots", "https://example.test/image.png")
  await rejected(data, 400, "invalid_files")
})

test("enforces per-file, count and combined attachment limits on the server", async () => {
  const data = form()
  data.set("log", new File(["x".repeat(feedbackLimits.log + 1)], "large.log"))
  await rejected(data, 413, "too_large")
  data.delete("log")
  for (let i = 0; i < feedbackLimits.screenshots; i++)
    data.append("screenshots", new File([png], `${i}.png`))
  const mock = mockSender()
  assert.equal(
    (await handleFeedback(request(data), config, mock.send)).status,
    202
  )
  data.append(
    "screenshots",
    new File([png], `${feedbackLimits.screenshots}.png`)
  )
  await rejected(data, 400, "invalid_files")
  data.delete("screenshots")
  data.append(
    "screenshots",
    new File([new Uint8Array(1.6 * 1024 * 1024)], "one.png")
  )
  data.append(
    "screenshots",
    new File([new Uint8Array(1.6 * 1024 * 1024)], "two.png")
  )
  await rejected(data, 413, "too_large")
})

test("bounds streamed requests even without Content-Length", async () => {
  let cancelled = false
  const body = new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array(1024 * 1024))
    },
    cancel() {
      cancelled = true
    },
  })
  const req = new Request(`${config.siteUrl}/api/feedback`, {
    method: "POST",
    headers: {
      origin: config.siteUrl,
      "content-type": "multipart/form-data; boundary=test",
    },
    body,
    duplex: "half",
  } as RequestInit)
  const mock = mockSender()
  assert.equal((await handleFeedback(req, config, mock.send)).status, 413)
  assert.equal(cancelled, true)
  assert.equal(mock.calls.length, 0)
})

test("rejects malformed multipart and non-multipart requests", async () => {
  const mock = mockSender()
  for (const [type, status] of [
    ["application/json", 415],
    ["multipart/form-data; boundary=broken", 400],
  ] as const) {
    const req = new Request(`${config.siteUrl}/api/feedback`, {
      method: "POST",
      body: "broken body",
      headers: { origin: config.siteUrl, "content-type": type },
    })
    assert.equal((await handleFeedback(req, config, mock.send)).status, status)
  }
  assert.equal(mock.calls.length, 0)
})

test("Resend rejection, invalid response and transport timeout never return success or leak details", async () => {
  for (const send of [
    async () =>
      Response.json({ message: "private upstream error" }, { status: 429 }),
    async () => Response.json({ unexpected: "private" }),
    async () => {
      throw new DOMException("private upstream URL", "TimeoutError")
    },
  ]) {
    const response = await handleFeedback(request(), config, send)
    assert.equal(response.status, 502)
    assert.deepEqual(await response.json(), { error: "send_failed" })
  }
})

test("redacts typical secrets and user paths without changing useful diagnostic messages", () => {
  const credentialField = ["pass", "word"].join("")
  assert.equal(
    redactLog(`${credentialField}=private-value`),
    `${credentialField}=[REDACTED]`
  )
  const output = redactLog(
    'api_key=secret-value token="token-value" password=hidden\nhttps://alice:password@example.test/?api_key=secret\nC:\\Users\\Alice\\app\n/home/bob/app\nASR connection failed: timeout'
  )
  assert.doesNotMatch(
    output,
    /secret-value|token-value|hidden|Alice|bob|alice:password/
  )
  assert.match(output, /ASR connection failed: timeout/)
})

test("client handles non-JSON platform 429 and 413 errors", async () => {
  assert.equal(
    await feedbackResponseError(
      new Response("<html>blocked</html>", { status: 429 })
    ),
    "rate_limited"
  )
  assert.equal(
    await feedbackResponseError(new Response("too large", { status: 413 })),
    "too_large"
  )
  assert.equal(
    await feedbackResponseError(new Response("gateway error", { status: 502 })),
    "send_failed"
  )
  assert.equal(
    await feedbackResponseError(
      Response.json({ error: "unavailable" }, { status: 503 })
    ),
    "unavailable"
  )
  assert.equal(attachmentError(null, [new File([png], "screen.png")]), null)
  assert.equal(
    attachmentError(
      null,
      Array.from(
        { length: feedbackLimits.screenshots },
        (_, index) => new File([png], `screen-${index}.png`)
      )
    ),
    null
  )
  assert.equal(
    attachmentError(
      null,
      Array.from(
        { length: feedbackLimits.screenshots + 1 },
        (_, index) => new File([png], `screen-${index}.png`)
      )
    ),
    "invalid_files"
  )
})
