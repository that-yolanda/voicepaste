import { source } from "@/lib/source"
import { siteUrl } from "@/lib/seo"
import { latest } from "@/lib/releases"

// Serves /llms.txt: a markdown overview of the site for AI assistants and
// other tools that fetch it by convention. Docs links and descriptions are
// generated from the docs frontmatter, so new pages are picked up here
// automatically.
export function GET() {
  const docLinks = source
    .getPages("en")
    .map((page) => {
      const path =
        "/docs" + (page.slugs.length ? "/" + page.slugs.join("/") : "")
      return `- [${page.data.title}](${siteUrl}/en${path}): ${
        page.data.description ?? ""
      }`
    })
    .join("\n")
  const body = `# VoicePaste

> Free, open-source voice input for macOS and Windows: dictate, translate, and polish text with your own speech recognition and language models.

VoicePaste turns your voice into text in any app. Press the global shortcut to record, and the recognized text is pasted directly into the focused input. Speech recognition runs either on online providers (Volcengine Doubao, ElevenLabs) or fully on-device with local sherpa-onnx models that work offline. An optional language model (DeepSeek, OpenAI, Anthropic, Gemini, OpenRouter, SiliconFlow, Ollama, or a custom endpoint) translates, organizes, or polishes the dictated text through reusable templates.

Key facts:
- Platforms: macOS (Apple Silicon and Intel) and Windows x64
- License: MIT, free of charge
- Recognition: online providers or local sherpa-onnx models (offline capable)
- Polishing: optional, with your own API key
- Latest version: ${latest.version} released ${latest.date}

## Docs

${docLinks}

## Downloads

- [Download page](${siteUrl}/en/downloads): installers for Apple Silicon, Intel, and Windows x64, with release notes
- [GitHub repository](https://github.com/that-yolanda/voicepaste): source code and issues
`
  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=3600",
    },
  })
}
