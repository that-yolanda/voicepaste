import { PageHeader, PageLayout } from "@/ui/layout/PageLayout";

export function FeedbackPage() {
  return (
    <PageLayout>
      <PageHeader title="帮助说明" />
      <div className="text-center py-12 text-text-muted text-sm">
        问题反馈功能即将上线，敬请期待。
      </div>
    </PageLayout>
  );
}
