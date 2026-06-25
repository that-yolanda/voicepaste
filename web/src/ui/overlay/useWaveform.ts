import { useEffect, useRef } from "react";

// Per-bar multipliers so the 4 bars rise with a slight phase spread from a
// single loudness scalar — mirrors the macOS native renderer, which also drives
// 4 bars from one backend level instead of per-band FFT data.
const WAVE_BAR_MULTIPLIERS = [1.0, 0.82, 0.92, 0.7];

export interface UseWaveform {
  /** Slots for the 4 bar elements; the component fills these via ref callbacks. */
  barsRef: React.RefObject<(HTMLSpanElement | null)[]>;
  /** The .status-bars container; its data-active is toggled from the RAF loop. */
  containerRef: React.RefObject<HTMLSpanElement | null>;
}

/**
 * Drives the 4-bar waveform from a single backend loudness scalar. Reads
 * `audioLevelRef` every frame (no re-render) and mutates each bar's transform
 * directly on the compositor. Collapses to rest when `active` is false.
 */
export function useWaveform(audioLevelRef: React.RefObject<number>, active: boolean): UseWaveform {
  const barsRef = useRef<(HTMLSpanElement | null)[]>([]);
  const containerRef = useRef<HTMLSpanElement | null>(null);
  const levelsRef = useRef<number[]>([]);
  const rafRef = useRef(0);

  useEffect(() => {
    if (!active) {
      // Collapse the bars to rest when not recording.
      levelsRef.current = [];
      for (const el of barsRef.current) {
        if (el) el.style.transform = "";
      }
      if (containerRef.current) containerRef.current.dataset.active = "false";
      return;
    }

    const tick = () => {
      const base = audioLevelRef.current;
      const bars = barsRef.current;
      for (let b = 0; b < bars.length; b++) {
        // Lift + compress so quiet speech still reads on the bars.
        const target = Math.min(1, (base * (WAVE_BAR_MULTIPLIERS[b] ?? 1) * 2.6) ** 0.75);
        // Asymmetric envelope: fast attack (snap up), slow release (ease down).
        const prev = levelsRef.current[b] ?? 0;
        const rate = target > prev ? 0.4 : 0.08;
        const level = prev + (target - prev) * rate;
        levelsRef.current[b] = level;

        const el = bars[b];
        if (el) {
          // scaleY relative to the 20px CSS baseline — compositor-only, no reflow.
          // level 0–1 maps to 3–18 px ⇒ scale 0.15–0.9.
          const clamped = Math.max(3, Math.min(18, 3 + level * 15));
          el.style.transform = `scaleY(${(clamped / 20).toFixed(3)})`;
        }
      }
      if (containerRef.current) {
        containerRef.current.dataset.active = base > 0.02 ? "true" : "false";
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    };
  }, [active, audioLevelRef]);

  return { barsRef, containerRef };
}
