import { strict as assert } from "node:assert"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import catalog from "../lib/model-support.json"

const registry = JSON.parse(
  readFileSync(new URL("../../registry.json", import.meta.url), "utf8")
)

test("the compatibility catalog covers transcription models and matches registry capabilities and languages", () => {
  const models = registry.models.filter(
    (model: { category: string }) => model.category === "asr"
  )
  assert.deepEqual(
    catalog.map((model) => model.id),
    models.map((model: { id: string }) => model.id)
  )
  for (const model of models) {
    const entry = catalog.find((item) => item.id === model.id)!
    assert.equal(entry.providerId, model.provider)
    assert.deepEqual(entry.name, [model.name, model.name_en ?? model.name])
    assert.equal(entry.online, model.type === "online")
    for (const key of [
      "streaming",
      "hotwords",
      "punctuation",
      "itn",
    ] as const) {
      assert.equal(
        entry.capabilities[key],
        model.capabilities[key],
        `${model.id}: ${key}`
      )
    }
    assert.deepEqual(entry.languages, model.languages)
    assert.equal(
      entry.capabilities.smoothing,
      Object.hasOwn(model.default_config, "enable_ddc")
    )
  }
})

test("the website uses the Volcengine display name independently of the app release", () => {
  const models = catalog.filter((model) => model.providerId === "bytedance")
  assert.ok(models.length > 0)
  for (const model of models) {
    assert.deepEqual(model.provider, ["火山引擎", "Volcengine"])
  }
})

test("speech cleanup does not inherit Message support for Qwen Streaming", () => {
  assert.deepEqual(
    catalog
      .filter((model) => model.capabilities.smoothing)
      .map((model) => model.id),
    ["doubao-streaming", "elevenlabs-realtime", "qwen-asr-message"]
  )
})
