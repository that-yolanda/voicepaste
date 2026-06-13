import { Eye, EyeOff } from "lucide-react";
import { forwardRef, useState, type ComponentPropsWithoutRef } from "react";

type InputProps = Omit<ComponentPropsWithoutRef<"input">, "onChange" | "className"> & {
  onChange: (value: string) => void;
  className?: string;
  inputClassName?: string;
};

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ onChange, className = "", type = "text", inputClassName = "", ...props }, ref) => {
    const [showPassword, setShowPassword] = useState(false);
    const isPassword = type === "password";
    const inputType = isPassword && showPassword ? "text" : type;

    return (
      <div className={`relative ${className}`}>
        <input
          ref={ref}
          type={inputType}
          onChange={(e) => onChange(e.target.value)}
          className={`w-full h-[34px] px-3 rounded-lg bg-input-bg border border-border text-text text-sm placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent-dim transition-colors ${isPassword ? "pr-10" : ""} ${inputClassName}`}
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
  }
);
