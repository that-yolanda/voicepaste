interface SegmentedOption {
  value: string;
  label: string;
}

interface SegmentedControlProps {
  options: SegmentedOption[];
  value: string;
  onChange: (value: string) => void;
}

export function SegmentedControl({ options, value, onChange }: SegmentedControlProps) {
  return (
    <div className="shrink-0 inline-flex border border-border rounded-lg overflow-hidden">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className={`px-4 py-1.5 text-sm font-medium transition-colors ${
            value === opt.value ? "bg-accent-soft text-accent" : "text-text-dim hover:bg-fill-hover"
          }`}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
