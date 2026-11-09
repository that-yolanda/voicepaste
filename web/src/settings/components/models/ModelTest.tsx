import { LoaderCircle, Play } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { errText } from "@/i18n/errText";
import { cancelModelTest, testModel } from "@/settings/bridge";
import { Button } from "@/settings/components/Button";

export interface ModelTestTarget {
  providerId: string;
  modelId: string;
  capability: "asr" | "llm";
  getConfig: () => Record<string, unknown>;
  disabled?: boolean;
  showToast: (message: string, tone: "success" | "error") => void;
}

export function useModelTest(target: ModelTestTarget | undefined) {
  const { t } = useTranslation();
  const [testing, setTesting] = useState(false);
  const active = useRef<{ id: string; signature: string } | null>(null);
  const signature = () =>
    JSON.stringify([target?.providerId, target?.modelId, target?.getConfig()], (_key, value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
        : value,
    );

  const cancel = useCallback(() => {
    const request = active.current;
    active.current = null;
    if (request) void cancelModelTest(request.id).catch(() => {});
  }, []);

  useEffect(() => () => cancel(), [cancel]);
  useEffect(() => {
    const current = signature();
    if (active.current && active.current.signature !== current) {
      cancel();
      setTesting(false);
    }
  });

  const run = async () => {
    if (!target || target.disabled || active.current) return;
    const request = { id: crypto.randomUUID(), signature: signature() };
    active.current = request;
    setTesting(true);
    try {
      await testModel(
        target.getConfig(),
        target.providerId,
        target.modelId,
        target.capability,
        request.id,
      );
      if (active.current === request) {
        target.showToast(t("ui.models.test_success"), "success");
      }
    } catch (failure) {
      if (active.current === request) target.showToast(errText(failure), "error");
    } finally {
      if (active.current === request) {
        active.current = null;
        setTesting(false);
      }
    }
  };

  return {
    testing,
    button: target ? (
      <Button variant="ghost" disabled={target.disabled || testing} onClick={() => void run()}>
        {testing ? <LoaderCircle size={15} className="animate-spin" /> : <Play size={15} />}
        {t(testing ? "ui.models.testing" : "ui.models.test")}
      </Button>
    ) : null,
  };
}
