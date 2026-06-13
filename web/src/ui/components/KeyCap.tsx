interface KeyCapProps {
  label: string;
  variant?: "default" | "side";
}

export function KeyCap({ label, variant = "default" }: KeyCapProps) {
  if (variant === "side") {
    return (
      <span className="inline-block text-[9px] px-[3px] py-px rounded font-semibold bg-fill-interactive text-text-dim border border-border border-b-2 uppercase leading-none align-middle">
        {label}
      </span>
    );
  }
  return (
    <kbd className="inline-flex items-center justify-center min-w-[22px] h-[22px] px-[5px] text-xs font-semibold rounded bg-fill-interactive text-text border border-border border-b-[2px] uppercase leading-none">
      {label}
    </kbd>
  );
}
