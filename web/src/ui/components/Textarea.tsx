import {
  type ComponentPropsWithoutRef,
  type FocusEventHandler,
  forwardRef,
  type KeyboardEventHandler,
  useEffect,
  useState,
} from "react";

type TextareaProps = Omit<
  ComponentPropsWithoutRef<"textarea">,
  "onChange" | "className" | "value" | "onBlur" | "onKeyDown"
> & {
  onChange: (value: string) => void;
  className?: string;
  textareaClassName?: string;
  value?: string;
  /** Buffer edits locally; call `onChange` only on blur / Ctrl+Enter.
   *  Avoids per-keystroke saves. Default: false (live). */
  commitOnBlur?: boolean;
  onBlur?: FocusEventHandler<HTMLTextAreaElement>;
  onKeyDown?: KeyboardEventHandler<HTMLTextAreaElement>;
};

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  (
    {
      onChange,
      className = "",
      textareaClassName = "",
      commitOnBlur = false,
      value,
      onBlur,
      onKeyDown,
      ...props
    },
    ref,
  ) => {
    const [draft, setDraft] = useState(value);

    useEffect(() => {
      if (commitOnBlur) setDraft(value);
    }, [value, commitOnBlur]);

    const commit = () => {
      if (draft !== value) onChange(String(draft ?? ""));
    };

    return (
      <div className={`relative ${className}`}>
        <textarea
          ref={ref}
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
            if (commitOnBlur && e.key === "Enter" && (e.metaKey || e.ctrlKey)) commit();
          }}
          className={`w-full min-h-28 px-3 py-2 rounded-lg bg-input-bg border border-border text-text text-sm placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent-dim transition-colors resize-none overscroll-y-auto ${textareaClassName}`}
          {...props}
        />
      </div>
    );
  },
);
