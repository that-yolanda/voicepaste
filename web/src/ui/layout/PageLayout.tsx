import type { ReactNode } from "react";

/* ========================================================================
   PageLayout — root wrapper for every settings page.
   Replaces the plain <div> at the top of each page's return.
   ======================================================================== */

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
      {description && <p className="text-xs text-text-muted mt-1">{description}</p>}
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

export function Section({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`bg-surface-card border border-border rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.08)] ${className}`}
    >
      {children}
    </div>
  );
}

/* ---------- SectionHeader — title row inside a Section ---------- */

export function SectionHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col px-4 pt-4 pb-3 gap-2">
      <div className="flex justify-between">
        <h2 className="text-sm font-semibold  text-text">{title}</h2>
        {action && <div className="max-w-1/2">{action}</div>}
      </div>
      {subtitle && <p className="min-w-0 flex-1 text-xs text-text-muted mt-0.5 ">{subtitle}</p>}
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
  return <div className={`px-4 py-2 ${className}`}>{children}</div>;
}

/* ---------- SectionItemList — vertical list of items with 4px top/bottom padding ---------- */

export function SectionItemList({ children }: { children: ReactNode }) {
  return <div className="py-1 space-y-2">{children}</div>;
}

/* ---------- SectionItem — single row with label + action ---------- */

export function SectionItem({
  title,
  description,
  action,
  children,
  last = false,
  className = "",
}: {
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  last?: boolean;
  className?: string;
}) {
  return (
    <div
      className={`group flex items-center gap-3 min-h-[42px] ${
        last ? "" : "border-b border-border-subtle pb-2"
      } ${className}`}
    >
      {(title || description) && (
        <div className="flex-1 min-w-0">
          {title && (
            <div className="text-sm font-[450] text-text flex items-center gap-[5px]">{title}</div>
          )}
          {description && (
            <div className="text-xs text-text-muted mt-0.5 leading-[1.4]">{description}</div>
          )}
        </div>
      )}
      {action && <div className="flex items-center">{action}</div>}
      {children}
    </div>
  );
}
