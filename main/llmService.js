const https = require("node:https");
const http = require("node:http");
const { logInfo, logError } = require("./logger");
const { loadPrompts } = require("./config");

const DEFAULT_SYSTEM_PROMPT =
  "你是一个文本整理助手。请将以下语音识别结果整理为格式规范的文本：修正标点符号，按语义分段，去除多余的语气词和重复，保持原文含义不变。只输出整理后的文本，不要添加任何解释或前缀。";

function resolveLlmEndpoint(rawUrl) {
  const parsedUrl = new URL(rawUrl);
  if (parsedUrl.pathname === "/" || parsedUrl.pathname === "") {
    parsedUrl.pathname = "/v1/chat/completions";
  }
  return parsedUrl;
}

function getActivePrompt(config) {
  const prompts = loadPrompts();
  const activePrompt =
    prompts.find((item) => item.id === config?.prompt_id && item.prompt?.trim()) ||
    prompts.find((item) => item.prompt?.trim());

  if (activePrompt?.prompt?.trim()) {
    return activePrompt.prompt.trim();
  }
  return DEFAULT_SYSTEM_PROMPT;
}

function callLlmApi(config, text) {
  return new Promise((resolve, reject) => {
    const parsedUrl = resolveLlmEndpoint(config.url);
    const isHttps = parsedUrl.protocol === "https:";
    const transport = isHttps ? https : http;

    const systemPrompt = getActivePrompt(config);

    const body = JSON.stringify({
      model: config.model || "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: text },
      ],
      temperature: 0.3,
      max_tokens: 4096,
    });

    const headers = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    };

    if (config.api_key) {
      headers.Authorization = `Bearer ${config.api_key}`;
    }

    const req = transport.request(
      {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: "POST",
        headers,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          if (res.statusCode >= 400) {
            reject(new Error(`LLM API returned ${res.statusCode}: ${data.slice(0, 200)}`));
            return;
          }
          try {
            const json = JSON.parse(data);
            const content = json.choices?.[0]?.message?.content?.trim();
            if (!content) {
              reject(new Error("LLM API returned empty content"));
              return;
            }
            resolve(content);
          } catch (e) {
            reject(new Error(`LLM API response parse error: ${e.message}`));
          }
        });
      },
    );

    req.setTimeout(15000, () => {
      req.destroy(new Error("LLM API request timed out (15s)"));
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function structureText(llmConfig, rawText) {
  if (!llmConfig?.enabled || !llmConfig?.url) {
    return rawText;
  }

  try {
    logInfo("LLM processing started", {
      model: llmConfig.model,
      textLength: rawText.length,
      promptId: llmConfig.prompt_id || "default",
    });
    const result = await callLlmApi(llmConfig, rawText);
    logInfo("LLM processing completed", { resultLength: result.length });
    return result;
  } catch (error) {
    logError("LLM processing failed, falling back to raw text", {
      message: error.message || String(error),
    });
    return rawText;
  }
}

module.exports = { structureText, DEFAULT_SYSTEM_PROMPT };
