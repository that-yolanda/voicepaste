/**
 * Audio utility functions — pure PCM helpers extracted from app.js.
 * No side effects, no DOM access.
 */

/** Clamp and convert Float32 PCM samples to Int16. */
export function floatTo16BitPCM(float32Array: Float32Array): Int16Array {
  const buffer = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, float32Array[i]));
    buffer[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return buffer;
}

/** Decimate a mono Float32 PCM buffer to a lower sample rate using averaging. */
export function downsampleBuffer(
  buffer: Float32Array,
  inputSampleRate: number,
  outputSampleRate: number,
): Float32Array {
  if (outputSampleRate === inputSampleRate) {
    return buffer;
  }
  const ratio = inputSampleRate / outputSampleRate;
  const newLength = Math.round(buffer.length / ratio);
  const result = new Float32Array(newLength);
  let dst = 0;
  let src = 0;
  while (dst < result.length) {
    const nextSrc = Math.round((dst + 1) * ratio);
    let sum = 0;
    let count = 0;
    for (let i = src; i < nextSrc && i < buffer.length; i += 1) {
      sum += buffer[i];
      count += 1;
    }
    result[dst] = count > 0 ? sum / count : 0;
    dst += 1;
    src = nextSrc;
  }
  return result;
}

/** Encode an Int16 PCM array as a Base64 string. */
export function int16ToBase64(int16Array: Int16Array): string {
  const uint8 = new Uint8Array(int16Array.buffer);
  let binary = "";
  for (let i = 0; i < uint8.length; i += 1) {
    binary += String.fromCharCode(uint8[i]);
  }
  return btoa(binary);
}
