use crate::app_state;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::AppHandle;

const TARGET_SAMPLE_RATE: u32 = 16_000;
const TARGET_CHUNK_SAMPLES: usize = 1600;

pub struct NativeAudioCapture {
    stop_tx: std::sync::mpsc::Sender<()>,
    input_thread: Option<thread::JoinHandle<()>>,
    forward_task: tauri::async_runtime::JoinHandle<()>,
}

impl NativeAudioCapture {
    async fn stop(mut self) {
        let _ = self.stop_tx.send(());
        if let Some(input_thread) = self.input_thread.take() {
            let _ = tokio::task::spawn_blocking(move || input_thread.join()).await;
        }
        let _ = self.forward_task.await;
    }
}

pub async fn start_capture(
    app: AppHandle,
    app_inner: Arc<app_state::AppInner>,
) -> Result<(), String> {
    let mut slot = app_inner.native_audio.lock().await;
    if slot.is_some() {
        return Ok(());
    }

    let (audio_tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Vec<f32>>();
    let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();

    let input_thread = thread::Builder::new()
        .name("voicepaste-native-audio".to_string())
        .spawn(move || {
            if let Err(error) = run_input_thread(audio_tx, stop_rx, ready_tx) {
                log_audio!(error, "Native audio thread exited with error: {}", error);
            }
        })
        .map_err(|e| format!("启动原生录音线程失败: {e}"))?;

    match ready_rx.recv() {
        Ok(Ok(())) => {}
        Ok(Err(error)) => {
            let _ = stop_tx.send(());
            let _ = input_thread.join();
            return Err(error);
        }
        Err(_) => {
            let _ = input_thread.join();
            return Err("原生录音线程提前退出".to_string());
        }
    }

    let forward_app = app.clone();
    let forward_inner = Arc::clone(&app_inner);
    let forward_task = tauri::async_runtime::spawn(async move {
        while let Some(samples) = rx.recv().await {
            let state = forward_inner.state.lock().await.clone();
            if matches!(
                state,
                app_state::AppState::Recording | app_state::AppState::Finishing
            ) {
                crate::commands::append_audio_samples(&forward_app, &forward_inner, samples).await;
            }
        }
    });

    *slot = Some(NativeAudioCapture {
        stop_tx,
        input_thread: Some(input_thread),
        forward_task,
    });
    log_audio!(info, "Native cpal microphone capture started");
    Ok(())
}

pub async fn stop_capture(app_inner: &Arc<app_state::AppInner>) {
    let capture = app_inner.native_audio.lock().await.take();
    if let Some(capture) = capture {
        capture.stop().await;
        log_audio!(info, "Native cpal microphone capture stopped");
    }
}

fn run_input_thread(
    tx: tokio::sync::mpsc::UnboundedSender<Vec<f32>>,
    stop_rx: std::sync::mpsc::Receiver<()>,
    ready_tx: std::sync::mpsc::Sender<Result<(), String>>,
) -> Result<(), String> {
    let final_chunk = Arc::new(Mutex::new(Vec::<f32>::with_capacity(TARGET_CHUNK_SAMPLES)));
    let stream = match build_input_stream(tx.clone(), Arc::clone(&final_chunk)) {
        Ok(stream) => stream,
        Err(error) => {
            let _ = ready_tx.send(Err(error.clone()));
            return Err(error);
        }
    };
    if let Err(error) = stream.play() {
        let message = format!("启动麦克风输入流失败: {error}");
        let _ = ready_tx.send(Err(message.clone()));
        return Err(message);
    }
    let _ = ready_tx.send(Ok(()));
    stop_rx
        .recv()
        .map_err(|e| format!("等待停止原生录音失败: {e}"))?;
    drop(stream);
    if let Ok(mut chunk) = final_chunk.lock() {
        if !chunk.is_empty() {
            let tail = std::mem::take(&mut *chunk);
            let _ = tx.send(tail);
        }
    }
    Ok(())
}

fn build_input_stream(
    tx: tokio::sync::mpsc::UnboundedSender<Vec<f32>>,
    final_chunk: Arc<Mutex<Vec<f32>>>,
) -> Result<cpal::Stream, String> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| "未找到默认麦克风输入设备".to_string())?;
    let config = device
        .default_input_config()
        .map_err(|e| format!("读取默认麦克风配置失败: {e}"))?;
    let sample_rate = config.sample_rate().0;
    let channels = usize::from(config.channels());
    let stream_config = config.config();

    log_audio!(
        info,
        "Native input device: sample_rate={}, channels={}, format={:?}",
        sample_rate,
        channels,
        config.sample_format()
    );

    let err_fn = |err| {
        log_audio!(error, "Native microphone stream error: {}", err);
    };

    match config.sample_format() {
        cpal::SampleFormat::F32 => build_stream::<f32>(
            &device,
            &stream_config,
            channels,
            sample_rate,
            tx,
            final_chunk,
            err_fn,
        ),
        cpal::SampleFormat::I16 => build_stream::<i16>(
            &device,
            &stream_config,
            channels,
            sample_rate,
            tx,
            final_chunk,
            err_fn,
        ),
        cpal::SampleFormat::U16 => build_stream::<u16>(
            &device,
            &stream_config,
            channels,
            sample_rate,
            tx,
            final_chunk,
            err_fn,
        ),
        other => Err(format!("不支持的采样格式: {other:?}")),
    }
}

fn build_stream<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    channels: usize,
    sample_rate: u32,
    tx: tokio::sync::mpsc::UnboundedSender<Vec<f32>>,
    final_chunk: Arc<Mutex<Vec<f32>>>,
    err_fn: impl FnMut(cpal::StreamError) + Send + 'static,
) -> Result<cpal::Stream, String>
where
    T: cpal::Sample + cpal::SizedSample + Send + 'static,
    f32: FromNativeSample<T>,
{
    let mut resampler = StreamingResampler::new(sample_rate, TARGET_SAMPLE_RATE);

    device
        .build_input_stream(
            config,
            move |data: &[T], _| {
                let mono = downmix_to_mono(data, channels);
                let samples = resampler.push(&mono);
                let Ok(mut chunk) = final_chunk.lock() else {
                    return;
                };
                for sample in samples {
                    chunk.push(sample);
                    if chunk.len() >= TARGET_CHUNK_SAMPLES {
                        let full = std::mem::take(&mut *chunk);
                        if tx.send(full).is_err() {
                            return;
                        }
                    }
                }
            },
            err_fn,
            None,
        )
        .map_err(|e| format!("创建麦克风输入流失败: {e}"))
}

fn downmix_to_mono<T>(data: &[T], channels: usize) -> Vec<f32>
where
    T: Copy,
    f32: FromNativeSample<T>,
{
    data.chunks(channels)
        .map(|frame| {
            let sum = frame
                .iter()
                .map(|&sample| f32::from_native_sample(sample))
                .sum::<f32>();
            sum / channels as f32
        })
        .collect()
}

trait FromNativeSample<T> {
    fn from_native_sample(sample: T) -> f32;
}

impl FromNativeSample<f32> for f32 {
    fn from_native_sample(sample: f32) -> f32 {
        sample.clamp(-1.0, 1.0)
    }
}

impl FromNativeSample<i16> for f32 {
    fn from_native_sample(sample: i16) -> f32 {
        sample as f32 / i16::MAX as f32
    }
}

impl FromNativeSample<u16> for f32 {
    fn from_native_sample(sample: u16) -> f32 {
        (sample as f32 - 32768.0) / 32768.0
    }
}

struct StreamingResampler {
    from_rate: u32,
    to_rate: u32,
    ratio: f64,
    position: f64,
    input: Vec<f32>,
}

impl StreamingResampler {
    fn new(from_rate: u32, to_rate: u32) -> Self {
        Self {
            from_rate,
            to_rate,
            ratio: from_rate as f64 / to_rate as f64,
            position: 0.0,
            input: Vec::new(),
        }
    }

    fn push(&mut self, samples: &[f32]) -> Vec<f32> {
        if samples.is_empty() {
            return Vec::new();
        }
        if self.from_rate == self.to_rate {
            return samples.to_vec();
        }

        self.input.extend_from_slice(samples);
        let mut output = Vec::new();
        while self.position + 1.0 < self.input.len() as f64 {
            let idx = self.position.floor() as usize;
            let frac = (self.position - idx as f64) as f32;
            let a = self.input[idx];
            let b = self.input[idx + 1];
            output.push(a + (b - a) * frac);
            self.position += self.ratio;
        }

        // Keep at least the last input sample as the interpolation anchor for
        // the next callback. With ratios such as 48k -> 16k, `position` can step
        // past the current buffer length after the final emitted sample; never
        // drain beyond the slice or CoreAudio's no-unwind callback will abort.
        let consumed = (self.position.floor() as usize).min(self.input.len().saturating_sub(1));
        if consumed > 0 {
            self.input.drain(..consumed);
            self.position -= consumed as f64;
        }
        output
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resampler_handles_48k_coreaudio_512_frame_callbacks() {
        let mut resampler = StreamingResampler::new(48_000, 16_000);
        for _ in 0..20 {
            let input = vec![0.25; 512];
            let output = resampler.push(&input);
            assert!(!output.is_empty());
        }
    }

    #[test]
    fn resampler_keeps_last_sample_for_next_interpolation_window() {
        let mut resampler = StreamingResampler::new(48_000, 16_000);
        let _ = resampler.push(&vec![0.0; 512]);
        assert!(!resampler.input.is_empty());
        assert!(resampler.position >= 0.0);
        assert!(resampler.position < resampler.input.len() as f64 + resampler.ratio);
    }
}
