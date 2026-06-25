import { useEffect, useRef, useState } from "react";
import type { AppState } from "./types";

export interface OverlayLayoutInput {
  finalText: string;
  partialText: string;
  visibleHintText: string;
  appState: AppState;
  retryVisible: boolean;
}

export interface UseOverlayLayout {
  measureRef: React.RefObject<HTMLDivElement | null>;
  pillRef: React.RefObject<HTMLDivElement | null>;
  transcriptRef: React.RefObject<HTMLDivElement | null>;
  wrap: boolean;
}

/**
 * Measures the transcript/hint text with a hidden node and sizes the pill to
 * fit (single-line ellipsis vs 3-line wrap), with a sticky "locked" width while
 * recording/finishing to prevent jitter. A 1:1 port of main-overlay.ts
 * scheduleResize — widths are applied directly to the pill element (no re-render
 * per frame); only the wrap toggle goes through React state.
 */
export function useOverlayLayout(input: OverlayLayoutInput): UseOverlayLayout {
  const measureRef = useRef<HTMLDivElement | null>(null);
  const pillRef = useRef<HTMLDivElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const layoutWidthRef = useRef(0);
  const layoutWrapRef = useRef(false);
  const renderedWidthRef = useRef(0);
  const rafRef = useRef(0);
  const [wrap, setWrap] = useState(false);

  useEffect(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      const measure = measureRef.current;
      const pill = pillRef.current;
      if (!measure || !pill) return;

      const hasText = Boolean(input.finalText || input.partialText);
      const hintText = input.visibleHintText;
      const hasHint = Boolean(hintText);
      const shouldMeasureHintOnly = hasHint;

      if (!hasText && !hasHint) {
        pill.style.width = "";
        renderedWidthRef.current = 0;
        layoutWidthRef.current = 0;
        layoutWrapRef.current = false;
        setWrap(false);
        return;
      }

      let measuredWidth = 0;
      if (hasText && !shouldMeasureHintOnly) {
        measure.textContent = `${input.finalText}${input.partialText}`.trim();
        measuredWidth = Math.ceil(measure.getBoundingClientRect().width);
      }
      let hintWidth = 0;
      if (hasHint) {
        measure.textContent = hintText;
        hintWidth = Math.ceil(measure.getBoundingClientRect().width);
      }

      const indicatorWidth = 22 + 12;
      const waveformWidth = input.appState === "recording" ? 18 + 12 : 0;
      const retryWidth = input.retryVisible ? 22 + 8 : 0;
      const chrome = 14 + 16 + 2 + indicatorWidth + waveformWidth + retryWidth;
      const textSlack = 10;
      const singleLineLimit = 520;
      const multiLineWidth = 520;
      const lockLayout =
        !shouldMeasureHintOnly &&
        (input.appState === "recording" || input.appState === "finishing");
      const shouldWrap =
        !shouldMeasureHintOnly && (layoutWrapRef.current || measuredWidth > singleLineLimit);
      const textWidth = Math.max(measuredWidth, hintWidth) + textSlack;
      const nextWidth = shouldWrap
        ? multiLineWidth + chrome
        : Math.min(singleLineLimit + chrome, Math.max(116, textWidth + chrome));

      if (!lockLayout) {
        layoutWidthRef.current = nextWidth;
        layoutWrapRef.current = shouldWrap;
      } else {
        layoutWidthRef.current = Math.max(layoutWidthRef.current || 0, nextWidth);
        layoutWrapRef.current = layoutWrapRef.current || shouldWrap;
      }
      setWrap(layoutWrapRef.current);

      let width = layoutWidthRef.current || nextWidth;
      if (width !== renderedWidthRef.current) {
        renderedWidthRef.current = width;
        pill.style.width = `${width}px`;
      }

      // Recover any sub-pixel overflow the estimate missed (single-line only).
      if (!layoutWrapRef.current && !shouldMeasureHintOnly && transcriptRef.current) {
        const overflow = transcriptRef.current.scrollWidth - transcriptRef.current.clientWidth;
        if (overflow > 0) {
          width += overflow + 6;
          layoutWidthRef.current = Math.max(layoutWidthRef.current || 0, width);
          renderedWidthRef.current = width;
          pill.style.width = `${width}px`;
        }
      }
    });
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [
    input.finalText,
    input.partialText,
    input.visibleHintText,
    input.appState,
    input.retryVisible,
  ]);

  return { measureRef, pillRef, transcriptRef, wrap };
}
