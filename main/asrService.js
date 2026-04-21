const WebSocket = require("ws");
const crypto = require("node:crypto");
const zlib = require("node:zlib");

function buildHeader(messageType, flags, serialization, compression) {
  const header = Buffer.alloc(4);
  header[0] = 0x11;
  header[1] = ((messageType & 0x0f) << 4) | (flags & 0x0f);
  header[2] = ((serialization & 0x0f) << 4) | (compression & 0x0f);
  header[3] = 0x00;
  return header;
}

function writeUInt32BE(num) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(num >>> 0, 0);
  return buffer;
}

function encodeFullClientRequest(payloadObject) {
  console.debug(payloadObject);

  const payload = Buffer.from(JSON.stringify(payloadObject), "utf8");
  const gzipped = zlib.gzipSync(payload);
  const header = buildHeader(0x01, 0x00, 0x01, 0x01);
  const payloadSize = writeUInt32BE(gzipped.length);

  return Buffer.concat([header, payloadSize, gzipped]);
}

function encodeAudioOnlyRequest(audioBuffer, isLast) {
  const flags = isLast ? 0x02 : 0x00;
  const header = buildHeader(0x02, flags, 0x00, 0x00);
  const payloadSize = writeUInt32BE(audioBuffer.length);

  return Buffer.concat([header, payloadSize, audioBuffer]);
}

function parseServerResponse(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) {
    return null;
  }

  const headerByte0 = buffer[0];
  const headerByte1 = buffer[1];
  const headerByte2 = buffer[2];
  const messageType = (headerByte1 >> 4) & 0x0f;
  const messageFlags = headerByte1 & 0x0f;
  let offset = (headerByte0 & 0x0f) * 4;

  if (messageType === 0x0f) {
    if (buffer.length < offset + 8) {
      return null;
    }

    const errorCode = buffer.readUInt32BE(offset);
    offset += 4;
    const errorSize = buffer.readUInt32BE(offset);
    offset += 4;

    if (buffer.length < offset + errorSize) {
      return null;
    }

    const errorText = buffer
      .subarray(offset, offset + errorSize)
      .toString("utf8")
      .trim();

    try {
      return {
        code: errorCode,
        ...JSON.parse(errorText),
      };
    } catch {
      return {
        code: errorCode,
        message: errorText,
      };
    }
  }

  if (messageType === 0x09) {
    if (buffer.length < offset + 4) {
      return null;
    }
    offset += 4;
  } else if (messageFlags === 0x01 || messageFlags === 0x03) {
    if (buffer.length < offset + 4) {
      return null;
    }
    offset += 4;
  }

  if (buffer.length < offset + 4) {
    return null;
  }

  const payloadSize = buffer.readUInt32BE(offset);
  offset += 4;

  if (buffer.length < offset + payloadSize) {
    return null;
  }

  const compression = headerByte2 & 0x0f;
  const serialization = (headerByte2 >> 4) & 0x0f;
  let payload = buffer.subarray(offset, offset + payloadSize);

  if (compression === 0x01) {
    try {
      payload = zlib.gunzipSync(payload);
    } catch {
      payload = buffer.subarray(offset, offset + payloadSize);
    }
  }

  if (serialization === 0x01) {
    const text = payload.toString("utf8").trim();

    try {
      return JSON.parse(text);
    } catch {
      const jsonStart = text.indexOf("{");
      const jsonEnd = text.lastIndexOf("}");

      if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
        return JSON.parse(text.slice(jsonStart, jsonEnd + 1));
      }

      return {
        raw_text: text,
      };
    }
  }

  return {
    messageType,
    messageFlags,
    raw_payload: payload,
  };
}

/**
 * 从 config.yaml 的 audio + request 配置直接构建 API 请求体。
 * 字段名与官方文档一一对应，config.yaml 中有什么就发什么。
 */
function buildApiRequestBody(audioConfig, requestConfig) {
  // audio 部分：过滤空值
  const audio = {};
  for (const [key, value] of Object.entries(audioConfig)) {
    if (value !== "" && value !== undefined && value !== null) {
      audio[key] = value;
    }
  }
  if (!audio.format) audio.format = "pcm";

  // request 部分：过滤空值，处理 corpus 和 context_hotwords
  const request = {};
  const contextHotwords = requestConfig.context_hotwords;

  for (const [key, value] of Object.entries(requestConfig)) {
    if (key === "corpus" || key === "context_hotwords") continue;
    if (value === "" || value === undefined || value === null) continue;
    request[key] = value;
  }

  if (!request.model_name) request.model_name = "bigmodel";

  // corpus 部分
  const corpus = {};
  const rawCorpus = requestConfig.corpus || {};
  for (const [key, value] of Object.entries(rawCorpus)) {
    if (key === "context_hotwords") continue; // 单独处理，不发送原数组
    if (value === "" || value === undefined || value === null) continue;
    corpus[key] = value;
  }

  // context_hotwords → corpus.context (JSON string)
  if (contextHotwords?.length) {
    corpus.context = JSON.stringify({ hotwords: contextHotwords });
  }

  if (Object.keys(corpus).length > 0) {
    request.corpus = corpus;
  }

  return {
    user: {
      uid: `voice_overlay_${Date.now()}`,
      did: "electron_desktop",
      platform: `${process.platform === "win32" ? "Windows" : "macOS"}/Electron`,
      sdk_version: "0.1.0",
      app_version: "0.1.0",
    },
    audio,
    request,
  };
}

function normalizeErrorMessage(error) {
  if (!error) {
    return "ASR 服务异常";
  }

  const text = String(error.message || error);

  if (text.includes("401") || text.includes("403")) {
    return "ASR 鉴权失败，请检查 AppID / Token / Resource ID";
  }

  if (text.includes("ENOTFOUND") || text.includes("ECONNREFUSED")) {
    return "ASR 网络连接失败";
  }

  if (text.includes("45000001")) {
    return "ASR 请求参数无效";
  }

  if (text.includes("45000081")) {
    return "ASR 等包超时";
  }

  return text;
}

function missingConnectionFieldError(field) {
  return new Error(`语音识别模型还未配置，缺少 ${field}`);
}

function isIgnorableRawText(text, connectId) {
  const normalized = String(text || "").trim();

  if (!normalized) {
    return true;
  }

  if (normalized === connectId) {
    return true;
  }

  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  if (uuidPattern.test(normalized)) {
    return true;
  }

  return false;
}

function createAsrSession({
  connection,
  audio: audioConfig,
  request: requestConfig,
  onOpen,
  onTranscript,
  onError,
  onClose,
}) {
  if (!connection?.url) {
    throw missingConnectionFieldError("connection.url");
  }

  if (!connection?.resource_id) {
    throw missingConnectionFieldError("connection.resource_id");
  }

  if (!connection?.app_id) {
    throw missingConnectionFieldError("connection.app_id");
  }

  if (!connection?.access_token) {
    throw missingConnectionFieldError("connection.access_token");
  }

  const connectId = crypto.randomUUID();
  const wsUrl = new URL(connection.url);
  wsUrl.searchParams.set("request_id", connectId);

  let isReady = false;
  let isCommitted = false;
  let isClosed = false;
  let isClosingExpected = false;
  let partialText = "";
  let finalText = "";
  let latestResultText = "";
  let pendingCommitResolve = null;
  let pendingCommitReject = null;
  let audioChunkCount = 0;

  const socket = new WebSocket(wsUrl, {
    headers: {
      "X-Api-App-Key": connection.app_id,
      "X-Api-Access-Key": connection.access_token,
      "X-Api-Resource-Id": connection.resource_id,
      "X-Api-Connect-Id": connectId,
    },
  });

  function clearPendingCommit(message) {
    if (pendingCommitReject) {
      pendingCommitReject(new Error(message));
      pendingCommitResolve = null;
      pendingCommitReject = null;
    }
  }

  function resolvePendingCommitWithServerFinal() {
    if (!pendingCommitResolve) {
      return;
    }

    const authoritativeText = (latestResultText || finalText).trim();
    pendingCommitResolve(authoritativeText);
    pendingCommitResolve = null;
    pendingCommitReject = null;
  }

  function isPunctuation(ch) {
    return /[，。！？、；：…—·\s,.!?;:'"()（）【】《》]/.test(ch);
  }

  /**
   * punctuation-agnostic prefix matching:
   * 逐字符比较 baseText 与 resultText，跳过标点差异，
   * 从 resultText 中去掉与 baseText 等价的前缀部分，返回剩余的 partial 文本。
   * 如果 baseText 不是 resultText 的前缀（有效字符完全不匹配），返回 null。
   */
  function splitPartialText(baseText, resultText) {
    if (!baseText || !resultText) return resultText || "";

    let fi = 0;
    let ri = 0;

    while (fi < baseText.length && ri < resultText.length) {
      while (fi < baseText.length && isPunctuation(baseText[fi])) fi++;
      while (ri < resultText.length && isPunctuation(resultText[ri])) ri++;

      if (fi >= baseText.length || ri >= resultText.length) break;

      if (baseText[fi] === resultText[ri]) {
        fi++;
        ri++;
      } else {
        break;
      }
    }

    while (fi < baseText.length && isPunctuation(baseText[fi])) fi++;
    while (ri < resultText.length && isPunctuation(resultText[ri])) ri++;

    if (fi >= baseText.length) {
      return resultText.slice(ri);
    }

    return null;
  }

  function handleRecognitionPayload(payload) {
    const utterances = payload?.result?.utterances;
    const resultText = (payload?.result?.text || "").trim();
    latestResultText = resultText || latestResultText;

    if (!Array.isArray(utterances) || utterances.length === 0) {
      if (resultText) {
        if (isCommitted) {
          finalText = resultText;
          partialText = "";
          onTranscript?.(finalText, partialText);
        } else {
          const partial = splitPartialText(finalText, resultText);
          if (partial !== null) {
            partialText = partial;
          } else {
            finalText = "";
            partialText = resultText;
          }
          onTranscript?.(finalText, partialText);
        }
      }
      return;
    }

    const completedText = utterances
      .filter((item) => item?.definite)
      .map((item) => item?.text || "")
      .join("")
      .trim();

    if (completedText) {
      finalText = completedText;
    }

    if (resultText) {
      const baseText = completedText || finalText;
      const partial = splitPartialText(baseText, resultText);
      if (partial !== null) {
        partialText = partial;
      } else if (completedText) {
        // nostream 重写文本导致 result.text 与 definite utterances 不一致，
        // 用 non-definite utterance 文本作为 partial
        partialText = utterances
          .filter((item) => !item?.definite)
          .map((item) => item?.text || "")
          .join("")
          .trim();
      } else {
        partialText = resultText;
      }
    } else {
      const latest = utterances[utterances.length - 1];
      partialText = latest?.definite ? "" : latest?.text || "";
    }

    if (isCommitted || !partialText) {
      partialText = "";
      onTranscript?.(resultText || finalText, "");
      return;
    }

    onTranscript?.(finalText, partialText);
  }

  socket.on("open", () => {
    try {
      const requestBody = buildApiRequestBody(audioConfig, requestConfig);
      console.log("[ASR] init request", {
        url: connection.url,
        resource_id: connection.resource_id,
        model_name: requestConfig.model_name || "bigmodel",
        enable_ddc: requestConfig.enable_ddc,
        enable_nonstream: requestConfig.enable_nonstream,
      });
      socket.send(encodeFullClientRequest(requestBody));
      isReady = true;
      onOpen?.();
    } catch (error) {
      onError?.(normalizeErrorMessage(error));
      clearPendingCommit(normalizeErrorMessage(error));
    }
  });

  socket.on("message", (raw, isBinary) => {
    try {
      if (!isBinary) {
        const payload = JSON.parse(Buffer.from(raw).toString("utf8"));
        if (payload.type === "error") {
          const message = payload.message || payload.error?.message || "ASR 服务异常";
          onError?.(message);
          clearPendingCommit(message);
          return;
        }
        return;
      }

      const payload = parseServerResponse(Buffer.from(raw));
      if (!payload) {
        return;
      }

      if (payload.messageType && payload.messageType !== 0x09 && payload.messageType !== 0x0f) {
        console.log("[ASR] ignore non-result frame", {
          messageType: payload.messageType,
          messageFlags: payload.messageFlags,
          size: payload.raw_payload?.length ?? 0,
        });
        return;
      }

      if (payload.raw_text) {
        const rawText = payload.raw_text.trim();
        console.log("[ASR] raw payload", rawText);

        if (isIgnorableRawText(rawText, connectId)) {
          return;
        }

        if (rawText) {
          if (isCommitted) {
            finalText = rawText;
            onTranscript?.(finalText, "");
          } else {
            partialText = rawText;
            onTranscript?.(finalText, partialText);
          }
        }
        return;
      }

      if (payload.code && payload.code !== 20000000) {
        console.error("[ASR] server error payload", payload);
        const message = payload.message || payload.msg || `ASR 错误码 ${payload.code}`;
        onError?.(message);
        clearPendingCommit(message);
        return;
      }

      if (!payload.result) {
        console.log("[ASR] payload without result", payload);
        return;
      }

      handleRecognitionPayload(payload);

      if (isCommitted && pendingCommitResolve) {
        const lastUtterance = payload?.result?.utterances?.at?.(-1);
        const resultText = (payload?.result?.text || "").trim();
        const hasStableFinal = Boolean(lastUtterance?.definite);

        if (hasStableFinal) {
          if (resultText) {
            latestResultText = resultText;
            finalText = resultText;
            partialText = "";
          }
          resolvePendingCommitWithServerFinal();
        }
      }
    } catch (error) {
      console.error("[ASR] message parse error", error);
      const message = normalizeErrorMessage(error);
      onError?.(message);
      clearPendingCommit(message);
    }
  });

  socket.on("error", (error) => {
    if (isClosingExpected) {
      return;
    }

    console.error("[ASR] websocket error", error);
    const message = normalizeErrorMessage(error);
    onError?.(message);
    clearPendingCommit(message);
  });

  socket.on("close", (code, reasonBuffer) => {
    isClosed = true;
    isReady = false;

    const reason = reasonBuffer?.toString?.() || "";
    console.log("[ASR] websocket close", { code, reason });

    if (isCommitted && (code === 1000 || reason === "finish last sequence")) {
      resolvePendingCommitWithServerFinal();
    } else if (isCommitted) {
      resolvePendingCommitWithServerFinal();
    }

    if (!isClosingExpected && !isCommitted && code !== 1000) {
      const message = `ASR 连接已断开${reason ? `：${reason}` : ""}`;
      onError?.(message);
      clearPendingCommit(message);
    }

    onClose?.({
      code,
      reason,
    });
  });

  return {
    isReady() {
      return isReady && socket.readyState === WebSocket.OPEN && !isClosed;
    },
    getTranscriptSnapshot() {
      return {
        finalText,
        partialText,
        latestResultText,
      };
    },
    appendAudio(base64Chunk) {
      if (!this.isReady() || isCommitted) {
        return;
      }

      const audioBuffer = Buffer.from(base64Chunk, "base64");
      audioChunkCount += 1;
      if (audioChunkCount <= 3) {
        console.log("[ASR] sending audio chunk", {
          index: audioChunkCount,
          bytes: audioBuffer.length,
        });
      }

      socket.send(encodeAudioOnlyRequest(audioBuffer, false));
    },
    commitAndAwaitFinal() {
      if (!this.isReady()) {
        throw new Error("ASR 连接已断开，请重新开始");
      }

      if (isCommitted) {
        throw new Error("录音已结束");
      }

      isCommitted = true;

      return new Promise((resolve, reject) => {
        pendingCommitResolve = resolve;
        pendingCommitReject = reject;

        const timeout = setTimeout(() => {
          if (pendingCommitResolve) {
            console.warn("[ASR] commitAndAwaitFinal timed out");
            resolvePendingCommitWithServerFinal();
          }
        }, 5000);

        const originalResolve = pendingCommitResolve;
        const originalReject = pendingCommitReject;

        pendingCommitResolve = (value) => {
          clearTimeout(timeout);
          originalResolve(value);
        };
        pendingCommitReject = (err) => {
          clearTimeout(timeout);
          originalReject(err);
        };

        socket.send(encodeAudioOnlyRequest(Buffer.alloc(0), true));
      });
    },
    close() {
      isReady = false;
      isClosingExpected = true;

      if (socket.readyState === WebSocket.OPEN) {
        socket.close(1000);
        return;
      }

      if (socket.readyState === WebSocket.CONNECTING) {
        socket.terminate();
      }
    },
  };
}

module.exports = {
  createAsrSession,
};
