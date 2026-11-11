import { useTranslation } from "react-i18next";
import { Badge } from "@/settings/components/Badge";
import { Button } from "@/settings/components/Button";

export function CurrentUsageBadge({ size = "sm" }: { size?: "sm" | "xs" }) {
  const { t } = useTranslation();
  return (
    <Badge variant="accent" size={size}>
      {t("ui.models.current_badge")}
    </Badge>
  );
}

export function DefaultAction({
  current,
  onSelect,
  disabled,
}: {
  current?: boolean;
  onSelect: () => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return current ? (
    <CurrentUsageBadge />
  ) : (
    <Button variant="ghost" disabled={disabled} onClick={onSelect}>
      {t("ui.models.set_default")}
    </Button>
  );
}
