import { LoaderCircle, Plus, RefreshCw } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/settings/components/Input";
import { Modal } from "@/settings/components/Modal";
import { localizedModelFields } from "@/settings/lib/model";
import type { RegistryModel } from "@/settings/types/models";

interface AddModelModalProps {
  open: boolean;
  onClose: () => void;
  hiddenPresets: RegistryModel[];
  allowCustom: boolean;
  onRestorePreset: (modelId: string) => void;
  onAddCustom: (id: string, name: string) => void;
  onCreateCustom: () => void;
  remoteModels?: Array<{ id: string; name?: string }>;
  onFetch?: () => void;
  fetching?: boolean;
}

export function AddModelModal({
  open,
  onClose,
  hiddenPresets,
  allowCustom,
  onRestorePreset,
  onAddCustom,
  onCreateCustom,
  remoteModels = [],
  onFetch,
  fetching,
}: AddModelModalProps) {
  const { t, i18n } = useTranslation();
  const [query, setQuery] = useState("");
  const close = () => {
    setQuery("");
    onClose();
  };
  return (
    <Modal open={open} onClose={close} title={t("ui.models.add_model")}>
      <div className="space-y-2">
        {onFetch && (
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <Input
                aria-label={t("ui.models.search_models")}
                placeholder={t("ui.models.search_models")}
                value={query}
                onChange={setQuery}
              />
            </div>
            <button
              type="button"
              aria-label={t("ui.models.refresh_models")}
              title={t("ui.models.refresh_models")}
              disabled={fetching}
              className="rounded-md p-2 text-text-muted hover:bg-fill-hover hover:text-text disabled:opacity-50"
              onClick={onFetch}
            >
              {fetching ? (
                <LoaderCircle size={16} className="animate-spin" />
              ) : (
                <RefreshCw size={16} />
              )}
            </button>
          </div>
        )}
        {(allowCustom || remoteModels.length > 0) && (
          <div className="max-h-64 space-y-1 overflow-y-auto">
            {allowCustom && (
              <button
                type="button"
                className="flex w-full items-center gap-3 rounded-lg bg-fill px-3 py-2 text-left hover:bg-fill-hover"
                onClick={() => {
                  close();
                  onCreateCustom();
                }}
              >
                <span className="min-w-0 flex-1 text-sm text-text">
                  {t("ui.models.add_model_custom")}
                </span>
                <Plus size={14} />
              </button>
            )}
            {remoteModels
              .filter((model) =>
                `${model.id} ${model.name || ""}`.toLowerCase().includes(query.toLowerCase()),
              )
              .map((model) => (
                <button
                  key={model.id}
                  type="button"
                  className="flex w-full items-center gap-3 rounded-lg bg-fill px-3 py-2 text-left hover:bg-fill-hover"
                  onClick={() => {
                    onAddCustom(model.id, model.name || model.id);
                    close();
                  }}
                >
                  <span className="min-w-0 flex-1 truncate text-sm text-text">
                    {model.name || model.id}
                  </span>
                  <Plus size={14} />
                </button>
              ))}
          </div>
        )}
        {hiddenPresets.map((preset) => {
          const { name, description } = localizedModelFields(preset, i18n.language);
          return (
            <button
              key={preset.id}
              type="button"
              className="flex w-full items-center gap-3 rounded-lg bg-fill px-3 py-2 text-left hover:bg-fill-hover"
              onClick={() => {
                onRestorePreset(preset.id);
                close();
              }}
            >
              <span className="min-w-0 flex-1">
                <span className="block text-sm text-text">{name}</span>
                {description && (
                  <span className="block text-xs text-text-muted">{description}</span>
                )}
              </span>
              <Plus size={14} />
            </button>
          );
        })}
        {hiddenPresets.length === 0 && !allowCustom && (
          <p className="text-center text-sm text-text-muted">{t("ui.models.add_model_empty")}</p>
        )}
      </div>
    </Modal>
  );
}
