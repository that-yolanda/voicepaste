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
      <h1 className="text-xl font-semibold tracking-[-0.01em] text-text">
        {title}
      </h1>
      {description && (
        <p className="text-xs text-text-muted mt-1">{description}</p>
      )}
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

export function Section({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`bg-surface-card py-4 space-y-4 border border-border rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.08)] ${className}`}
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
    <div className="px-4 flex justify-between gap-2 w-full items-center">
      <div className="space-y-1">
        <h2 className="font-semibold">{title}</h2>
        {subtitle && (
          <p className="min-w-0 flex-1 text-xs text-text-muted mt-0.5 ">
            {subtitle}
          </p>
        )}
      </div>

      {action && (
        <div
          className={`shrink-0 flex justify-end max-w-[55%] ${subtitle ? "mb-auto" : ""}`}
        >
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

export function SectionItemList({ children }: { children: ReactNode }) {
  return <div className="space-y-2">{children}</div>;
}

/* ---------- SectionItem — title/action row with optional content below ---------- */

export function SectionItem({
  title,
  description,
  action,
  children,
  last = false,
  className = "",
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  last?: boolean;
  className?: string;
}) {
  return (
    <div
      className={`group flex flex-col gap-2 min-h-10 ${
        last ? "" : "border-b border-border-subtle pb-2"
      } ${className}`}
    >
      <div className="flex justify-between gap-2 w-full items-center">
        <div className="space-y-1">
          <div>{title}</div>
          {description && (
            <div className="w-full text-xs text-text-muted leading-[1.4]">
              {description}
            </div>
          )}
        </div>
        {action && (
          <div
            className={`shrink-0 flex justify-end max-w-3/4 ${description ? "mb-auto" : ""}`}
          >
            {action}
          </div>
        )}
      </div>

      {children && <div className="w-full min-w-0">{children}</div>}
    </div>
  );
}
