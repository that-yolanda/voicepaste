import { useWaveform } from "../useWaveform";

interface WaveformProps {
  audioLevelRef: React.RefObject<number>;
  active: boolean;
}

/** Right-side 4-bar waveform, driven by the backend audio level through the
 * useWaveform RAF loop. Hidden unless `active` (recording). */
export function Waveform({ audioLevelRef, active }: WaveformProps) {
  const { barsRef, containerRef } = useWaveform(audioLevelRef, active);
  return (
    <span className="wave" aria-hidden="true">
      <span className="status-bars" ref={containerRef} data-active="false">
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            className="status-bar"
            ref={(el) => {
              barsRef.current[i] = el;
            }}
          />
        ))}
      </span>
    </span>
  );
}
