import type { ReactNode } from "react";

interface SegmentedOption {
  value: string;
  label: ReactNode;
  ariaLabel?: string;
}

interface SegmentedControlProps {
  options: SegmentedOption[];
  value: string;
  onChange: (value: string) => void;
  label?: string;
  role?: "tablist";
  align?: "start" | "end";
  className?: string;
}

export function SegmentedControl({
  options,
  value,
  onChange,
  label,
  role,
  align = "end",
  className = "",
}: SegmentedControlProps) {
  return (
    <div
      {...(role === "tablist"
        ? { role: "tablist", "aria-label": label }
        : { role: "group", "aria-label": label })}
      className={`relative inline-flex shrink-0 rounded-lg bg-fill-subtle p-0.5 ${align === "end" ? "ml-auto" : ""} ${className}`}
    >
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          aria-label={opt.ariaLabel}
          title={opt.ariaLabel}
          {...(role === "tablist"
            ? { role: "tab", "aria-selected": value === opt.value }
            : { "aria-pressed": value === opt.value })}
          data-selected={value === opt.value}
          className={`relative z-1 flex min-w-0 items-center justify-center whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-accent ${value === opt.value ? "text-accent bg-surface-solid shadow-sm ring-1 ring-inset ring-border" : "text-text-dim hover:text-text"}`}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
