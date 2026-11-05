import { RotateCcw } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/settings/components/Badge";
import { Button } from "@/settings/components/Button";
import { Input } from "@/settings/components/Input";
import { Modal } from "@/settings/components/Modal";
import { localizedModelFields } from "@/settings/lib/model";
import type { RegistryModel } from "@/settings/types/models";

interface AddModelModalProps {
  open: boolean;
  onClose: () => void;
  /** Registry presets hidden from the provider's list (removable on restore). */
  hiddenPresets: RegistryModel[];
  /** Whether free-form custom model ids are allowed (LLM only this phase). */
  allowCustom: boolean;
  onRestorePreset: (modelId: string) => void;
  onAddCustom: (id: string, name: string) => void;
}

/**
 * "添加模型": restore presets removed from the positive list, and (for LLM
 * providers) add a custom model id by hand. ASR keeps presets-only this phase.
 */
export function AddModelModal({
  open,
  onClose,
  hiddenPresets,
  allowCustom,
  onRestorePreset,
  onAddCustom,
}: AddModelModalProps) {
  const { t, i18n } = useTranslation();
  const [customId, setCustomId] = useState("");
  const [customName, setCustomName] = useState("");

  const submitCustom = () => {
    const id = customId.trim();
    if (!id) return;
    onAddCustom(id, customName.trim() || id);
    setCustomId("");
    setCustomName("");
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title={t("ui.models.add_model")}>
      <div className="space-y-5">
        {hiddenPresets.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-text">{t("ui.models.add_model_presets")}</h3>
            {hiddenPresets.map((preset) => {
              const { name } = localizedModelFields(preset, i18n.language);
              return (
                <div
                  key={preset.id}
                  className="flex items-center gap-3 rounded-lg border border-border-subtle bg-fill px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-text">{name}</div>
                    <div className="text-xs text-text-muted">{preset.description}</div>
                  </div>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      onRestorePreset(preset.id);
                      onClose();
                    }}
                  >
                    <RotateCcw size={14} />
                    {t("ui.models.restore")}
                  </Button>
                </div>
              );
            })}
          </div>
        )}

        {allowCustom && (
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-text">{t("ui.models.add_model_custom")}</h3>
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
              <Button variant="accent" disabled={!customId.trim()} onClick={submitCustom}>
                {t("ui.models.add")}
              </Button>
            </div>
            <p className="text-xs text-text-muted">
              <Badge variant="ghost" size="xs">
                {t("ui.models.hint")}
              </Badge>
              {t("ui.models.custom_model_hint")}
            </p>
          </div>
        )}

        {hiddenPresets.length === 0 && !allowCustom && (
          <p className="text-sm text-text-muted">{t("ui.models.add_model_empty")}</p>
        )}
      </div>
    </Modal>
  );
}
