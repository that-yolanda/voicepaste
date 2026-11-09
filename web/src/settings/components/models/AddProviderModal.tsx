import { useTranslation } from "react-i18next";
import { Badge } from "@/settings/components/Badge";
import { Modal } from "@/settings/components/Modal";
import { ProviderIcon } from "@/settings/components/models/ProviderIcon";
import type { RegistryProvider } from "@/settings/types/models";

interface AddProviderModalProps {
  open: boolean;
  onClose: () => void;
  catalog: RegistryProvider[];
  onAdd: (providerId: string) => Promise<void>;
}

/** Localized provider display fields (mirrors localizedModelFields). */
export function localizedProviderFields(provider: RegistryProvider, locale: string) {
  const en = locale.startsWith("en");
  return {
    name: (!en && provider.name) || provider.name_en || provider.name,
  };
}

/**
 * "添加供应商" catalog: two-column cards for every registry provider not yet
 * added. Whole card is clickable — no per-card buttons (design review).
 */
export function AddProviderModal({ open, onClose, catalog, onAdd }: AddProviderModalProps) {
  const { t, i18n } = useTranslation();
  return (
    <Modal open={open} onClose={onClose} title={t("ui.models.add_provider")}>
      {catalog.length === 0 ? (
        <p className="text-center text-sm text-text-muted">{t("ui.models.add_provider_empty")}</p>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          {catalog.map((provider) => {
            const { name } = localizedProviderFields(provider, i18n.language);
            return (
              <button
                key={provider.id}
                type="button"
                className="flex min-h-16 items-center gap-2.5 rounded-lg border border-border-subtle bg-fill px-2.5 py-2.5 text-left transition-colors hover:bg-fill-hover"
                onClick={() => {
                  void onAdd(provider.id).then(onClose);
                }}
              >
                <ProviderIcon provider={provider} />
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="truncate text-sm font-semibold text-text">{name}</span>
                  <span className="flex items-center gap-1">
                    {provider.kind === "local" && (
                      <Badge variant="success" size="xs">
                        {t("ui.models.tag_local")}
                      </Badge>
                    )}
                    {provider.capabilities.map((cap) => (
                      <Badge key={cap} variant="default" size="xs">
                        {t(cap === "asr" ? "ui.models.tag_asr" : "ui.models.tag_llm")}
                      </Badge>
                    ))}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </Modal>
  );
}
