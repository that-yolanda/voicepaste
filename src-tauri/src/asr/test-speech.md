# Built-in model test speech

`test-speech.pcm` is a fixed synthetic sample generated locally with macOS
speech synthesis (`say`), then converted with FFmpeg. It contains no user
recording. The app embeds it at compile time and never needs speech synthesis
or microphone access to run a model test.

Transcript:

> 你好。
> Hello.

Format: 16 kHz, mono, signed 16-bit little-endian PCM without a header,
1.0350625 seconds, including 0.2 seconds of trailing silence.

Tests require a nonempty final transcription, not an exact transcript match.
This checks basic operation; it does not measure accuracy or language coverage.
