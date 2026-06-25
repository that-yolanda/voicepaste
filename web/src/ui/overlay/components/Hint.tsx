interface HintProps {
  text: string;
}

/** Status/error message, shown in place of the transcript when there is a hint
 * (driven by the parent stage's data-mode="hint"). Colour comes from the
 * stage's data-level. */
export function Hint({ text }: HintProps) {
  return (
    <div className="hint">
      <span className="hint-label">{text}</span>
    </div>
  );
}
