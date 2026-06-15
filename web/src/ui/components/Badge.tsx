import type { ReactNode } from "react";

interface BadgeProps {
  children: ReactNode;
  variant?: "default" | "accent" | "success" | "muted" | "danger";
  onClick?: () => void;
  title?: string;
  className?: string;
}

export function Badge({
  children,
  variant = "default",
  onClick,
  title,
  className = "",
}: BadgeProps) {
  const variants: Record<string, string> = {
    default: "bg-fill-interactive text-text-dim",
    accent: "bg-accent-soft text-accent",
    success: "bg-success/15 text-success",
    muted: "bg-fill-track text-text-muted",
    danger: "bg-error/15 text-error",
  };
  const classes = `inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium transition-colors ${variants[variant]} ${onClick ? "cursor-pointer hover:bg-fill-hover" : ""} ${className}`;

  if (onClick) {
    return (
      <button type="button" className={`${classes} border-0`} title={title} onClick={onClick}>
        {children}
      </button>
    );
  }

  return (
    <span className={classes} title={title}>
      {children}
    </span>
  );
}
