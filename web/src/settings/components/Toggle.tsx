interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}

export function Toggle({ checked, onChange, disabled }: ToggleProps) {
  return (
    <label
      className={`relative inline-flex items-center cursor-pointer ${disabled ? "opacity-50 pointer-events-none" : ""}`}
    >
      <input
        type="checkbox"
        className="sr-only peer"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="w-[38px] h-[22px] bg-fill-track rounded-full peer-checked:bg-accent transition-colors duration-200 after:content-[''] after:absolute after:top-[3px] after:left-[3px] after:w-[16px] after:h-[16px] after:bg-white after:rounded-full after:shadow after:transition-transform after:duration-200 peer-checked:after:translate-x-[16px]" />
    </label>
  );
}
