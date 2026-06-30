//! Audio file playback via rodio (macOS + Windows).
//!
//! The single in-process playback path for all sounds: recording cues and the
//! settings "preview" button. Replaces the former per-platform process spawns
//! (afplay / PowerShell `SoundPlayer`) that lived in `paste`. Playing in the
//! long-lived backend process means a sound is never cut short by the overlay
//! WebView being torn down, and there is no decode/keep-alive jank. rodio
//! decodes via symphonia (mp3 out of the box) and handles resampling internally,
//! so no sample-rate matching is needed.

/// Play an audio file on a background thread. The thread blocks on
/// `sleep_until_end` so the `OutputStream` stays alive for the whole sound.
/// Errors are logged only — rodio + symphonia is stable enough that no fallback
/// (afplay/PowerShell) is warranted. Empty path is a no-op.
pub(crate) fn play_audio_file(file_path: &str) {
    if file_path.is_empty() {
        return;
    }
    let path = file_path.to_string();
    if let Err(error) = std::thread::Builder::new()
        .name("voicepaste-sound".to_string())
        .spawn(move || {
            if let Err(error) = play(&path) {
                log_app!(warn, "Audio playback failed ({}): {}", path, error);
            }
        })
    {
        log_app!(warn, "Failed to spawn audio thread: {}", error);
    }
}

fn play(path: &str) -> Result<(), Box<dyn std::error::Error>> {
    use std::fs::File;
    use std::io::BufReader;
    // Keep `_stream` alive for the whole call: dropping it stops playback.
    let (_stream, handle) = rodio::OutputStream::try_default()?;
    let sink = rodio::Sink::try_new(&handle)?;
    let file = File::open(path)?;
    sink.append(rodio::Decoder::new(BufReader::new(file))?);
    sink.sleep_until_end();
    Ok(())
}
