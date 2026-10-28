import { ChevronDown } from "lucide-react";
import { type ComponentPropsWithoutRef, forwardRef } from "react";

type SelectProps = Omit<ComponentPropsWithoutRef<"select">, "value" | "onChange"> & {
  value: string;
  onChange: (value: string) => void;
  options: readonly { value: string; label: string }[];
};

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ value, onChange, options, className = "", ...props }, ref) => (
    <div className={`relative w-full ${className}`}>
      <select
        ref={ref}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-8.5 w-full appearance-none rounded-lg border border-border bg-input-bg pl-3 pr-9 text-sm text-text outline-none transition-colors focus:ring-1 focus:ring-accent-dim disabled:cursor-not-allowed disabled:opacity-50"
        {...props}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown
        size={16}
        aria-hidden="true"
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-text-dim"
      />
    </div>
  ),
);
