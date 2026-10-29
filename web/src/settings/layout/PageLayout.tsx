/**
 * Root for all setting pages
 * Use Page* as Page Layout
 * ┌-- PageLayout --┐
 * | PageHeader     |
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

import { Info } from "lucide-react";
import type { HTMLAttributes, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Tooltip } from "@/settings/components/Tooltip";

export function PageLayout({ children }: { children: ReactNode }) {
  return <div className="space-y-5">{children}</div>;
}

/* ---------- PageHeader ---------- */

export function PageHeader({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="mb-6">
      <h1 className="text-xl font-semibold tracking-[-0.01em] text-text">{title}</h1>
      {description && <p className="text-sm text-text-muted mt-1">{description}</p>}
      {children}
    </div>
  );
}

/* ---------- PageContent — free-form content area ---------- */

export function PageContent({ children }: { children: ReactNode }) {
  return <div>{children}</div>;
}

/* ========================================================================
   Section — Card-like container grouping related settings.
   Replaces the old .section-card / Card component.
   ======================================================================== */

export function Section({ children, className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...props}
      className={`bg-surface-card py-2 space-y-4 border border-border rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.08)] ${className}`}
    >
      {children}
    </div>
  );
}

/* ---------- SectionHeader — title row inside a Section ---------- */

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
    <div className="px-4 pt-2 flex justify-between gap-2 w-full items-center">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">{title}</h2>
        {subtitle && (
          <p className={`min-w-0 flex-1 text-text-muted mt-0.5 ${subtitleClassName}`}>{subtitle}</p>
        )}
      </div>

      {action && (
        <div className={`shrink-0 flex justify-end max-w-[55%] ${subtitle ? "mb-auto" : ""}`}>
          {action}
        </div>
      )}
    </div>
  );
}

/* ---------- SectionContent — padded body inside a Section ---------- */

export function SectionContent({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={`px-4 space-y-2 ${className}`}>{children}</div>;
}

/* ---------- SectionItemList — vertical list of items with 4px top/bottom padding ---------- */

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
  htmlFor,
  description,
  tooltip,
  action,
  children,
  last = false,
  className = "flex-1",
}: {
  title: string;
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
      className={`group flex flex-col gap-2 min-h-10 justify-center ${
        last ? "" : "border-b border-border-subtle pb-2"
      }`}
    >
      <div className="flex justify-between w-full gap-2 items-center">
        <div>
          <div className="flex items-center gap-1">
            {htmlFor ? <label htmlFor={htmlFor}>{title}</label> : <span>{title}</span>}
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
            className={`flex justify-end max-w-3/4 ${className} ${description ? "mb-auto" : ""}`}
          >
            {action}
          </div>
        )}
      </div>

      {children && <div className="w-full min-w-0">{children}</div>}
    </div>
  );
}
