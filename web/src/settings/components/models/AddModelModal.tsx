import { Plus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/settings/components/Button";
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
}

export function AddModelModal({
  open,
  onClose,
  hiddenPresets,
  allowCustom,
  onRestorePreset,
  onAddCustom,
}: AddModelModalProps) {
  const { t, i18n } = useTranslation();
  const [custom, setCustom] = useState(false);
  const [customId, setCustomId] = useState("");
  const [customName, setCustomName] = useState("");
  const close = () => {
    setCustom(false);
    setCustomId("");
    setCustomName("");
    onClose();
  };
  return (
    <Modal open={open} onClose={close} title={t("ui.models.add_model")}>
      <div className="space-y-2">
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
        {allowCustom && !custom && (
          <button
            type="button"
            className="flex w-full items-center gap-3 rounded-lg bg-fill px-3 py-2 text-left text-text hover:bg-fill-hover"
            onClick={() => setCustom(true)}
          >
            <Plus size={14} />
            {t("ui.models.add_model_custom")}
          </button>
        )}
        {custom && (
          <div className="space-y-2">
            <Input
              aria-label={t("ui.models.model_id")}
              placeholder={t("ui.models.model_id_placeholder")}
              value={customId}
              onChange={setCustomId}
            />
            <Input
              aria-label={t("ui.models.model_name")}
              placeholder={t("ui.models.model_name_placeholder")}
              value={customName}
              onChange={setCustomName}
            />
            <div className="flex justify-end">
              <Button
                variant="accent"
                disabled={!customId.trim()}
                onClick={() => {
                  const id = customId.trim();
                  if (!id) return;
                  onAddCustom(id, customName.trim() || id);
                  close();
                }}
              >
                {t("ui.models.add")}
              </Button>
            </div>
          </div>
        )}
        {hiddenPresets.length === 0 && !allowCustom && (
          <p className="text-sm text-text-muted">{t("ui.models.add_model_empty")}</p>
        )}
      </div>
    </Modal>
  );
}
