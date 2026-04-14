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

    const errorText = buffer.subarray(offset, offset + errorSize).toString("utf8").trim();

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
      // Some server frames are not gzip-compressed even when the header suggests it.
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

function createInitRequest(sampleRate, options = {}) {
  const audio = {
    format: options.audioFormat || "pcm",
    codec: options.audioCodec || "raw",
    rate: sampleRate,
    bits: options.audioBits || 16,
    channel: options.audioChannel || 1,
  };

  if (options.language) {
    audio.language = options.language;
  }

  const request = {
    model_name: options.modelName || "bigmodel",
    model_version: options.modelVersion || "400",
    operation: options.operation || "submit",
    sequence: options.sequence ?? 0,
    enable_itn: options.enableItn !== false,
    enable_punc: options.enablePunc !== false,
    enable_ddc: options.enableDdc !== false,
    show_utterances: options.showUtterances !== false,
    result_type: options.resultType || "full",
    end_window_size: options.endWindowSize || 800,
    force_to_speech_time: options.forceToSpeechTime || 1000,
  };

  if (options.enableNonstream) {
    request.enable_nonstream = true;
  }

  if (options.boostingTableId) {
    request.corpus = {
      boosting_table_id: options.boostingTableId,
    };
  }

  if (options.contextHotwords?.length) {
    request.corpus = request.corpus || {};
    request.corpus.context = JSON.stringify({
      hotwords: options.contextHotwords,
    });
  }

  return {
    user: {
      uid: `voice_overlay_${Date.now()}`,
      did: "electron_desktop",
      platform: "macOS/Electron",
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

function isIgnorableRawText(text, connectId) {
  const normalized = String(text || "").trim();

  if (!normalized) {
    return true;
  }

  if (normalized === connectId) {
    return true;
  }

  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  if (uuidPattern.test(normalized)) {
    return true;
  }

  return false;
}

function createAsrSession({
  url,
  resourceId,
  appId,
  accessToken,
  language,
  sampleRate = 16000,
  audioFormat,
  audioCodec,
  audioBits,
  audioChannel,
  modelName,
  modelVersion,
  operation,
  sequence,
  enableItn,
  enablePunc,
  enableNonstream,
  enableDdc,
  showUtterances,
  resultType,
  endWindowSize,
  forceToSpeechTime,
  boostingTableId,
  contextHotwords,
  onOpen,
  onPartial,
  onFinal,
  onError,
  onClose,
}) {
  if (!url) {
    throw new Error("缺少 ASR_WS_URL");
  }

  if (!resourceId) {
    throw new Error("缺少 ASR_RESOURCE_ID");
  }

  if (!appId) {
    throw new Error("缺少 VOLCENGINE_APP_ID");
  }

  if (!accessToken) {
    throw new Error("缺少 VOLCENGINE_ACCESS_TOKEN");
  }

  const connectId = crypto.randomUUID();
  const wsUrl = new URL(url);
  wsUrl.searchParams.set("request_id", connectId);

  let isReady = false;
  let isCommitted = false;
  let isClosed = false;
  let partialText = "";
  let finalText = "";
  let latestResultText = "";
  let pendingCommitResolve = null;
  let pendingCommitReject = null;
  let audioChunkCount = 0;

  const parsedContextHotwords = Array.isArray(contextHotwords) ? contextHotwords : [];

  const socket = new WebSocket(wsUrl, {
    headers: {
      "X-Api-App-Key": appId,
      "X-Api-Access-Key": accessToken,
      "X-Api-Resource-Id": resourceId,
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

  function handleRecognitionPayload(payload) {
    const utterances = payload?.result?.utterances;
    const resultText = (payload?.result?.text || "").trim();
    latestResultText = resultText || latestResultText;

    if (!Array.isArray(utterances) || utterances.length === 0) {
      if (resultText) {
        if (isCommitted) {
          finalText = resultText;
          partialText = "";
          onFinal?.(finalText);
        } else {
          finalText = "";
          partialText = resultText;
          onPartial?.(partialText);
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
      if (completedText && resultText.startsWith(completedText)) {
        partialText = resultText.slice(completedText.length).trimStart();
      } else if (completedText === resultText) {
        partialText = "";
      } else {
        partialText = resultText;
      }
    } else {
      const latest = utterances[utterances.length - 1];
      partialText = latest?.definite ? "" : (latest?.text || "");
    }

    if (isCommitted || !partialText) {
      partialText = "";
      onFinal?.(resultText || finalText);
      return;
    }

    onFinal?.(finalText);
    onPartial?.(partialText);
  }

  socket.on("open", () => {
    try {
      console.log("[ASR] init options", {
        language: language || "",
        sampleRate,
        modelName: modelName || "bigmodel",
        modelVersion: modelVersion || "400",
        enableNonstream: Boolean(enableNonstream),
        enableDdc: enableDdc !== false,
        boostingTableId: boostingTableId || "",
        contextHotwords: parsedContextHotwords.map((item) => item.word),
      });
      socket.send(
        encodeFullClientRequest(
          createInitRequest(sampleRate, {
            language,
            audioFormat,
            audioCodec,
            audioBits,
            audioChannel,
            modelName,
            modelVersion,
            operation,
            sequence,
            enableItn,
            enablePunc,
            enableNonstream,
            enableDdc,
            showUtterances,
            resultType,
            endWindowSize,
            forceToSpeechTime,
            boostingTableId,
            contextHotwords: parsedContextHotwords,
          }),
        ),
      );
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
            onFinal?.(finalText);
          } else {
            partialText = rawText;
            onPartial?.(partialText);
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
    }

    if (!isCommitted && code !== 1000) {
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

        socket.send(encodeAudioOnlyRequest(Buffer.alloc(0), true));
      });
    },
    close() {
      isReady = false;

      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close(1000);
      }
    },
  };
}

module.exports = {
  createAsrSession,
};
