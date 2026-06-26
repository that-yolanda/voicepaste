import { Eye, EyeOff } from "lucide-react";
import {
  type ComponentPropsWithoutRef,
  type FocusEventHandler,
  forwardRef,
  type KeyboardEventHandler,
  useEffect,
  useState,
} from "react";

type InputProps = Omit<
  ComponentPropsWithoutRef<"input">,
  "onChange" | "className" | "value" | "onBlur" | "onKeyDown"
> & {
  onChange: (value: string) => void;
  className?: string;
  inputClassName?: string;
  value?: string | number;
  /** Buffer edits locally; call `onChange` only on blur / Enter.
   *  Avoids per-keystroke saves (e.g. config fields). Default: false (live). */
  commitOnBlur?: boolean;
  onBlur?: FocusEventHandler<HTMLInputElement>;
  onKeyDown?: KeyboardEventHandler<HTMLInputElement>;
};

export const Input = forwardRef<HTMLInputElement, InputProps>(
  (
    {
      onChange,
      className = "",
      type = "text",
      inputClassName = "",
      commitOnBlur = false,
      value,
      onBlur,
      onKeyDown,
      ...props
    },
    ref,
  ) => {
    const [showPassword, setShowPassword] = useState(false);
    const [draft, setDraft] = useState(value);
    const isPassword = type === "password";
    const inputType = isPassword && showPassword ? "text" : type;

    // Sync external value → draft (commitOnBlur mode only, when value changes externally).
    useEffect(() => {
      if (commitOnBlur) setDraft(value);
    }, [value, commitOnBlur]);

    const commit = () => {
      if (draft !== value) onChange(String(draft ?? ""));
    };

    return (
      <div className={`relative ${className}`}>
        <input
          ref={ref}
          type={inputType}
          value={commitOnBlur ? draft : value}
          onChange={(e) => {
            if (commitOnBlur) setDraft(e.target.value);
            else onChange(e.target.value);
          }}
          onBlur={(e) => {
            if (commitOnBlur) commit();
            onBlur?.(e);
          }}
          onKeyDown={(e) => {
            onKeyDown?.(e);
            if (commitOnBlur && e.key === "Enter") commit();
          }}
          className={`w-full h-8.5 px-3 rounded-lg bg-input-bg border border-border text-text text-sm placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent-dim transition-colors ${isPassword ? "pr-10" : ""} ${inputClassName}`}
          {...props}
        />
        {isPassword && (
          <button
            type="button"
            className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text p-0.5"
            onClick={() => setShowPassword((v) => !v)}
          >
            {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        )}
      </div>
    );
  },
);
