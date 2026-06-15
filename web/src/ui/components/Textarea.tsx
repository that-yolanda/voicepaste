import { type ComponentPropsWithoutRef, forwardRef } from "react";

type TextareaProps = Omit<
  ComponentPropsWithoutRef<"textarea">,
  "onChange" | "className"
> & {
  onChange: (value: string) => void;
  className?: string;
  textareaClassName?: string;
};

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ onChange, className = "", textareaClassName = "", ...props }, ref) => {
    return (
      <div className={`relative ${className}`}>
        <textarea
          ref={ref}
          onChange={(e) => onChange(e.target.value)}
          className={`w-full min-h-28 px-3 py-2 rounded-lg bg-input-bg border border-border text-text text-sm placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent-dim transition-colors resize-none overscroll-y-auto ${textareaClassName}`}
          {...props}
        />
      </div>
    );
  },
);
