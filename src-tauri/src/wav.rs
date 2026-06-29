//! 16kHz mono PCM WAV read/write + speech-presence heuristic.
//!
//! Pure helpers shared by the recording lifecycle: saving diagnostics WAVs,
//! reading them back for retry, and detecting whether a stop actually captured
//! speech. No platform or Tauri dependencies.

/// Write `samples` (32-bit float, -1..1) as a 16kHz mono 16-bit PCM WAV.
pub fn write_wav_16k_mono(path: &std::path::Path, samples: &[f32]) -> Result<(), String> {
    const SAMPLE_RATE: u32 = 16_000;
    const CHANNELS: u16 = 1;
    const BYTES_PER_SAMPLE: u16 = 2;

    let data_bytes = samples.len() * BYTES_PER_SAMPLE as usize;
    let riff_size = 36usize
        .checked_add(data_bytes)
        .ok_or_else(|| "WAV too large".to_string())?;
    let mut wav = Vec::with_capacity(44 + data_bytes);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(riff_size as u32).to_le_bytes());
    wav.extend_from_slice(b"WAVE");
    wav.extend_from_slice(b"fmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&CHANNELS.to_le_bytes());
    wav.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
    wav.extend_from_slice(&(SAMPLE_RATE * CHANNELS as u32 * BYTES_PER_SAMPLE as u32).to_le_bytes());
    wav.extend_from_slice(&(CHANNELS * BYTES_PER_SAMPLE).to_le_bytes());
    wav.extend_from_slice(&(BYTES_PER_SAMPLE * 8).to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&(data_bytes as u32).to_le_bytes());
    for &sample in samples {
        let pcm = (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
        wav.extend_from_slice(&pcm.to_le_bytes());
    }

    std::fs::write(path, wav).map_err(|e| e.to_string())
}

/// Read a 16kHz mono 16-bit PCM WAV into 32-bit float samples.
pub fn read_wav_16k_mono(path: &std::path::Path) -> Result<Vec<f32>, String> {
    let data = std::fs::read(path).map_err(|e| format!("读取录音文件失败: {e}"))?;
    if data.len() < 44 || &data[0..4] != b"RIFF" || &data[8..12] != b"WAVE" {
        return Err("录音文件不是有效 WAV".to_string());
    }
    let mut pos = 12usize;
    let mut channels = 0u16;
    let mut sample_rate = 0u32;
    let mut bits = 0u16;
    let mut data_range = None;
    while pos + 8 <= data.len() {
        let id = &data[pos..pos + 4];
        let size = u32::from_le_bytes([data[pos + 4], data[pos + 5], data[pos + 6], data[pos + 7]])
            as usize;
        let start = pos + 8;
        let end = start.saturating_add(size).min(data.len());
        if id == b"fmt " && size >= 16 && end <= data.len() {
            channels = u16::from_le_bytes([data[start + 2], data[start + 3]]);
            sample_rate = u32::from_le_bytes([
                data[start + 4],
                data[start + 5],
                data[start + 6],
                data[start + 7],
            ]);
            bits = u16::from_le_bytes([data[start + 14], data[start + 15]]);
        } else if id == b"data" {
            data_range = Some(start..end);
            break;
        }
        pos = start + size + (size % 2);
    }
    if channels != 1 || sample_rate != 16_000 || bits != 16 {
        return Err("仅支持 16kHz mono 16-bit WAV 重试".to_string());
    }
    let range = data_range.ok_or_else(|| "WAV 缺少 data chunk".to_string())?;
    Ok(data[range]
        .chunks_exact(2)
        .map(|chunk| i16::from_le_bytes([chunk[0], chunk[1]]) as f32 / 32768.0)
        .collect())
}

/// Heuristic: did this recording capture actual sound (speech) rather than
/// silence? Used to tell a genuine no-speech stop (end immediately) apart from
/// speech whose transcript was lost to a slow/failed network (keep commit +
/// retry). Biased toward "has sound" so real speech is never silently dropped.
pub fn recording_has_audio_signal(samples: &[f32]) -> bool {
    // 16k mono. Native capture has no AEC, so the start cue bleeds into the mic
    // at the very beginning; skip that leading window so the cue is never mistaken
    // for speech. Anything the user actually says runs past it (and if they spoke
    // inside it, a transcript would have arrived, short-circuiting this check).
    const CUE_SKIP: usize = 11_200; // ~0.7s at 16k covers the start cue + echo tail
    const MIN_VOICE: usize = 1_600; // need ~100ms of real audio after the cue
    if samples.len() < CUE_SKIP + MIN_VOICE {
        return false;
    }
    let tail = &samples[CUE_SKIP..];
    let peak = tail.iter().fold(0.0f32, |m, &s| m.max(s.abs()));
    let rms = (tail.iter().map(|&s| s * s).sum::<f32>() / tail.len() as f32).sqrt();
    // A quiet mic noise floor sits well below these; speech clears both easily.
    peak >= 0.02 && rms >= 0.004
}

#[cfg(test)]
mod tests {
    use super::recording_has_audio_signal;

    #[test]
    fn silence_is_not_treated_as_speech() {
        let silence = vec![0.0f32; 16_000];
        assert!(!recording_has_audio_signal(&silence));
    }

    #[test]
    fn quiet_noise_floor_is_not_treated_as_speech() {
        // ~ -54 dBFS hum: below both gates, must not look like speech.
        let noise: Vec<f32> = (0..16_000)
            .map(|i| if i % 2 == 0 { 0.002 } else { -0.002 })
            .collect();
        assert!(!recording_has_audio_signal(&noise));
    }

    #[test]
    fn very_short_clip_is_not_treated_as_speech() {
        // Under 100ms even at full amplitude is an accidental tap, not speech.
        let blip = vec![0.5f32; 800];
        assert!(!recording_has_audio_signal(&blip));
    }

    #[test]
    fn loud_sustained_signal_is_treated_as_speech() {
        // A 0.3-amplitude tone clears both the peak and RMS gates.
        let tone: Vec<f32> = (0..16_000).map(|i| 0.3 * (i as f32 * 0.2).sin()).collect();
        assert!(recording_has_audio_signal(&tone));
    }

    #[test]
    fn start_cue_bleed_then_silence_is_not_treated_as_speech() {
        // Loud cue in the first ~0.5s, silence afterward: must be skipped, not
        // mistaken for the user speaking (no AEC in native capture).
        let mut samples = vec![0.0f32; 16_000];
        for (i, s) in samples.iter_mut().enumerate().take(8_000) {
            *s = 0.4 * (i as f32 * 0.3).sin();
        }
        assert!(!recording_has_audio_signal(&samples));
    }
}
