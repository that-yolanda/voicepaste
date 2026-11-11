/**
 * Root for all setting pages
 * Use Page* as Page Layout
 * ┌-- PageLayout --┐
 * | PageContent    |
 * └----------------┘
 *
 * Use Section* as grouped configuration Layout
 * ┌- Section -----------------┐
 * | SectionHeader             |
 * | ┌- SectionContent ------┐ |
 * | | ┌- SectionItemList -┐ | |
 * | | | ┌- SectionItem -┐ | | |
 * | | | | children      | | | |
 * | | | └---------------┘ | | |
 * | | └-------------------┘ | |
 * | |-----------------------┘ |
 * └---------------------------┘
 */

import { ChevronRight, Info } from "lucide-react";
import { type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode, useId } from "react";
import { useTranslation } from "react-i18next";
import { Collapse } from "@/settings/components/Collapse";
import { Tooltip } from "@/settings/components/Tooltip";

export function PageLayout({ children }: { children: ReactNode }) {
  return <div className="space-y-4">{children}</div>;
}

/* ---------- PageContent — free-form content area ---------- */

export function PageContent({ children }: { children: ReactNode }) {
  return <div>{children}</div>;
}

/* ========================================================================
   Section — Group with a heading above its content card.
   Replaces the old .section-card / Card component.
   ======================================================================== */

export function Section({ children, className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...props} className={`space-y-2 ${className}`}>
      {children}
    </div>
  );
}

/* ---------- SectionHeader — title row above the content card ---------- */

export function SectionHeader({
  title,
  subtitle,
  subtitleClassName = "text-sm",
  action,
}: {
  title: string;
  subtitle?: string;
  subtitleClassName?: string;
  action?: ReactNode;
}) {
  return (
    <div className="px-1 min-h-6 flex justify-between gap-2 w-full items-center">
      <div className="space-y-1">
        <h2 className="text-xs font-normal text-text-muted">{title}</h2>
        {subtitle && (
          <p className={`min-w-0 flex-1 text-text-muted mt-0.5 ${subtitleClassName}`}>{subtitle}</p>
        )}
      </div>

      {action && (
        <div className={`-my-1 shrink-0 flex justify-end max-w-[55%] ${subtitle ? "mb-auto" : ""}`}>
          {action}
        </div>
      )}
    </div>
  );
}

/* ---------- SectionContent — padded content card inside a Section ---------- */

export function SectionContent({
  children,
  className = "",
  plain = false,
}: {
  children: ReactNode;
  className?: string;
  plain?: boolean;
}) {
  return (
    <div
      className={`${plain ? "py-2 space-y-2" : "rounded-lg border border-border bg-surface-card px-3 py-2 space-y-2"} ${className}`}
    >
      {children}
    </div>
  );
}

/* Full-width rows without the spacing used by form sections. */
export function SectionRows({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface-card">
      {children}
    </div>
  );
}

/* ---------- SectionItemList — shared spacing between setting rows ---------- */

export function SectionItemList({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={`space-y-2 ${className}`}>{children}</div>;
}

/* ---------- SectionItem — title/action row with optional content below ---------- */

export function SectionItem({
  title,
  titleAction,
  htmlFor,
  description,
  tooltip,
  action,
  children,
  last = false,
  className = "flex-1",
}: {
  title: string;
  titleAction?: ReactNode;
  htmlFor?: string;
  description?: ReactNode;
  tooltip?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  last?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <div
      className={`group flex flex-col gap-1.5 min-h-9 justify-center ${
        last ? "" : "border-b border-border-subtle pb-2"
      }`}
    >
      <div className="section-item-row flex justify-between w-full gap-2 items-center">
        <div className="section-item-label min-w-0">
          <div className="flex items-center gap-1">
            {htmlFor ? <label htmlFor={htmlFor}>{title}</label> : <span>{title}</span>}
            {titleAction}
            {tooltip && (
              <Tooltip content={tooltip} label={t("ui.settings.tooltip_help", { title })}>
                <Info size={14} aria-hidden="true" />
              </Tooltip>
            )}
          </div>
          {description && <div className="text-xs text-text-muted text-wrap">{description}</div>}
        </div>
        {action && (
          <div
            className={`section-item-action flex min-w-0 justify-end ${className} ${description ? "mb-auto" : ""}`}
          >
            {action}
          </div>
        )}
      </div>

      {children && <div className="w-full min-w-0">{children}</div>}
    </div>
  );
}

/** Clickable full-width row; the enclosing list owns separators. */
export function SectionRow({
  children,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...props}
      className={`flex min-h-12 w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-fill-hover/40 disabled:opacity-50 ${className}`}
    >
      {children}
    </button>
  );
}

export function SectionAccordionItem({
  title,
  open,
  onToggle,
  children,
  status,
  ...props
}: {
  title: string;
  status?: ReactNode;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
} & Omit<HTMLAttributes<HTMLDivElement>, "title" | "children">) {
  const panelId = useId();
  return (
    <div {...props} className="border-b border-border-subtle last:border-b-0">
      <SectionRow aria-expanded={open} aria-controls={panelId} onClick={onToggle}>
        <span className="min-w-0 flex-1 break-words font-semibold">{title}</span>
        {status}
        <ChevronRight
          size={15}
          className={`shrink-0 transition-transform motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
        />
      </SectionRow>
      <Collapse open={open} id={panelId}>
        <div className="bg-surface-expanded px-3 pb-3 pt-1">{children}</div>
      </Collapse>
    </div>
  );
}
