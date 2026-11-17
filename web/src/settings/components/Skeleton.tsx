import { ChevronRight, Lightbulb, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/settings/components/Button";
import { PageLayout, SectionRow, SectionRows } from "@/settings/layout/PageLayout";

export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden="true" className={`rounded bg-fill-interactive ${className}`} />;
}

export function HomeSkeleton() {
  return (
    <div aria-hidden="true" className="space-y-5">
      <Skeleton className="h-7 w-44 mb-6" />
      <div className="grid grid-cols-4 gap-4">
        {[0, 1, 2, 3].map((key) => (
          <div
            key={key}
            className="flex flex-col justify-between h-24 p-4 rounded-xl bg-surface-card border border-border"
          >
            <Skeleton className="h-5 w-12" />
            <Skeleton className="h-3 w-16 self-end max-w-full" />
          </div>
        ))}
      </div>
      <Skeleton className="h-56 rounded-xl" />
      <Skeleton className="h-28 rounded-xl" />
    </div>
  );
}

export function LibrarySkeleton() {
  const { t } = useTranslation();
  return (
    <div aria-busy="true">
      <PageLayout>
        <SectionRows>
          {["first", "second", "third"].map((id) => (
            <div key={id} className="border-b border-border-subtle last:border-b-0">
              <SectionRow disabled>
                <span className="min-w-0 flex-1">
                  <Skeleton className="h-4 w-36" />
                </span>
                <ChevronRight size={15} aria-hidden="true" />
              </SectionRow>
            </div>
          ))}
        </SectionRows>
        <div className="flex items-center gap-2">
          <Button variant="ghost" disabled>
            <Plus size={14} />
            {t("ui.library.add")}
          </Button>
          <Button variant="ghost" disabled>
            <Lightbulb size={14} />
            {t("ui.library.templates")}
          </Button>
        </div>
      </PageLayout>
    </div>
  );
}
