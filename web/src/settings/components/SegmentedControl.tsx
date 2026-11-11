import { type ReactNode, useCallback, useLayoutEffect, useRef, useState } from "react";

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
  const list = useRef<HTMLDivElement>(null);
  const [indicator, setIndicator] = useState({ left: 0, width: 0 });
  const measure = useCallback(() => {
    const selected = list.current?.querySelector<HTMLElement>('[data-selected="true"]');
    if (!selected) return;
    const { offsetLeft: left, offsetWidth: width } = selected;
    setIndicator((previous) =>
      previous.left === left && previous.width === width ? previous : { left, width },
    );
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Selection and translated labels change the measured DOM.
  useLayoutEffect(() => {
    measure();
  }, [measure, options, value]);
  useLayoutEffect(() => {
    const observer = new ResizeObserver(measure);
    if (list.current) observer.observe(list.current);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure]);
  return (
    <div
      ref={list}
      {...(role === "tablist"
        ? { role: "tablist", "aria-label": label }
        : { role: "group", "aria-label": label })}
      className={`relative inline-flex shrink-0 rounded-lg bg-fill-subtle p-0.5 ${align === "end" ? "ml-auto" : ""} ${className}`}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute bottom-0.5 left-0 top-0.5 rounded-md border border-border bg-surface-solid shadow-sm transition-[transform,width] duration-200 ease-out motion-reduce:transition-none"
        style={{ width: indicator.width, transform: `translateX(${indicator.left}px)` }}
      />
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
          className={`relative z-1 flex min-w-0 items-center justify-center whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-accent ${value === opt.value ? "text-accent" : "text-text-dim hover:text-text"}`}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
