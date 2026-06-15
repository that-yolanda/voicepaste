import type { ReactNode } from "react";

interface ButtonProps {
  children: ReactNode;
  onClick?: () => void;
  variant?: "default" | "accent" | "danger" | "ghost";
  size?: "sm" | "md" | "icon";
  className?: string;
  disabled?: boolean;
  type?: "button" | "submit";
}

export function Button({
  children,
  onClick,
  variant = "default",
  size = "md",
  className = "",
  disabled,
  type = "button",
}: ButtonProps) {
  const base =
    "inline-flex items-center gap-1 font-medium rounded-md transition-colors focus:outline-none justify-center";
  const sizes =
    size === "icon"
      ? "p-2"
      : size === "sm"
        ? "px-2 py-1 text-xs"
        : "px-3 py-1.5 text-sm";
  const variants: Record<string, string> = {
    default:
      "bg-transparent text-text border border-border hover:border-accent hover:text-accent",
    accent: "bg-accent text-text-on-accent hover:bg-accent-hover",
    danger: "bg-error/20 text-error hover:bg-error/30",
    ghost: "text-text-dim hover:text-text hover:bg-fill-hover",
  };

  return (
    <button
      type={type}
      className={`${base} ${sizes} ${variants[variant]} ${disabled ? "opacity-50 pointer-events-none" : ""} ${className}`}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
