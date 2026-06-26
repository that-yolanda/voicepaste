interface KeyCapProps {
  label: string;
  /** Optional small badge rendered as a superscript at the label's top-right. */
  side?: string;
}

export function KeyCap({ label, side }: KeyCapProps) {
  return (
    <kbd className="inline-flex items-center justify-center min-w-5 h-5 px-1 text-xs font-semibold rounded bg-fill-interactive text-text border border-border border-b-2 uppercase leading-none">
      {label}
      {side ? (
        <span className="ml-0.5 self-start text-[9px] font-bold leading-none text-text-dim">
          {side}
        </span>
      ) : null}
    </kbd>
  );
}
