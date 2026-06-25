import { useEffect } from "react";
import { Hint } from "./components/Hint";
import { Indicator } from "./components/Indicator";
import { RetryButton } from "./components/RetryButton";
import { Transcript } from "./components/Transcript";
import { Waveform } from "./components/Waveform";
import { visibleHintText } from "./overlayText";
import { useOverlayLayout } from "./useOverlayLayout";
import { useOverlayState } from "./useOverlayState";

export function OverlayApp() {
  const { state, appearance, audioLevelRef, onRetry } = useOverlayState();

  const visibleHint = visibleHintText(state);
  const hasHint = Boolean(visibleHint);
  const showTranscript = !hasHint;

  const { measureRef, pillRef, transcriptRef, wrap } = useOverlayLayout({
    finalText: state.finalText,
    partialText: state.partialText,
    visibleHintText: visibleHint,
    appState: state.appState,
    retryVisible: state.retryVisible,
  });

  // Auto-scroll the transcript to the latest line as it grows. transcriptRef is
  // a stable ref (intentionally omitted); the effect re-runs on content change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: transcriptRef is a stable ref; finalText/partialText drive the scroll timing
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [showTranscript, state.finalText, state.partialText]);

  // macOS renders the pill natively (NSGlassEffectView), so the WebView stage
  // stays hidden there. Temporary compat — dropped once the macOS overlay window
  // is converted to a native Window (see the macos-native-overlay-window step).
  const hidden = appearance.platform === "macos";

  return (
    <main className="overlay">
      <section
        className="stage"
        data-state={state.appState}
        data-mode={hasHint ? "hint" : "transcript"}
        data-level={hasHint ? state.hintLevel : "info"}
        data-retry={state.retryVisible && state.hintLevel === "error" ? "true" : "false"}
        data-retrying={state.retrying ? "true" : "false"}
        style={hidden ? { display: "none" } : undefined}
      >
        <div className="pill" data-wrap={wrap ? "multi" : "single"} ref={pillRef}>
          <Indicator />
          <div className="body">
            <Transcript
              ref={transcriptRef}
              finalText={showTranscript ? state.finalText : ""}
              partialText={showTranscript ? state.partialText : ""}
            />
            <Hint text={visibleHint} />
          </div>
          <Waveform audioLevelRef={audioLevelRef} active={state.appState === "recording"} />
          <RetryButton
            hotkey={state.retryHotkey}
            disabled={state.retrying || !state.retryVisible}
            onClick={onRetry}
          />
        </div>
      </section>
      <div className="measure-text" ref={measureRef} />
    </main>
  );
}
