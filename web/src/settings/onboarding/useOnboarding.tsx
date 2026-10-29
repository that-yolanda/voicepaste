import { type Driver, driver } from "driver.js";
import { type Checklist, checklist } from "driver.js/checklist";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/settings/components/Button";
import { Modal } from "@/settings/components/Modal";
import { Toast, useToast } from "@/settings/components/Toast";
import type { SectionId } from "@/settings/layout/Sidebar";
import { useSettings } from "@/settings/SettingsProvider";
import { getSteps, TASK_SECTION, TASKS, type TaskId, waitForTarget } from "./steps";
import "driver.js/dist/driver.css";
import "driver.js/dist/checklist.css";
import "./onboarding.css";

export function useOnboarding(navigate: (section: SectionId) => void) {
  const { t } = useTranslation();
  const { config, settings, loading, scheduleSave } = useSettings();
  const [active, setActive] = useState(false);
  const [welcomeClosed, setWelcomeClosed] = useState(false);
  const [saving, setSaving] = useState(false);
  const completed = useRef(new Set<TaskId>());
  const skipped = useRef(false);
  const current = useRef<{ task: TaskId; index: number } | null>(null);
  const tour = useRef<Driver | null>(null);
  const list = useRef<Checklist | null>(null);
  const cancel = useRef<() => void>(() => {});
  const { toast, showToast } = useToast();
  const isMac = settings?.runtime?.platform === "macos";
  const welcome = !loading && config?.app?.onboarding_pending === true && !welcomeClosed;

  useEffect(() => {
    if (!welcome) return;
    const dialog = document.querySelector<HTMLElement>("[data-onboarding-welcome]");
    const previous = document.activeElement;
    const buttons = () =>
      Array.from(dialog?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
    buttons()[0]?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const controls = buttons();
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener("keydown", trap);
    return () => {
      window.removeEventListener("keydown", trap);
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [welcome]);

  const dismissInvitation = useCallback(async () => {
    setSaving(true);
    try {
      await scheduleSave({ app: { onboarding_pending: false } });
      setWelcomeClosed(true);
      return true;
    } catch {
      showToast(t("ui.onboarding.saveError"), "error");
      return false;
    } finally {
      setSaving(false);
    }
  }, [scheduleSave, showToast, t]);

  const start = useCallback(async () => {
    if (saving) return;
    if (active) {
      cancel.current();
      list.current?.open();
      return;
    }
    if (await dismissInvitation()) setActive(true);
  }, [active, dismissInvitation, saving]);

  const exit = useCallback(async () => {
    if (saving) return;
    if (!(await dismissInvitation())) return;
    cancel.current();
    setActive(false);
  }, [dismissInvitation, saving]);

  const exitRef = useRef(exit);
  exitRef.current = exit;

  useEffect(() => {
    if (!active) return;
    let disposed = false;
    let suppressRestore = false;
    let pending: AbortController | null = null;
    let modalPaused = false;
    const resume = current.current;
    const label = (task: TaskId) =>
      t(`ui.onboarding.tasks.${task}`) +
      (task === "llm" && skipped.current ? ` (${t("ui.onboarding.skipped")})` : "");

    const decorate = () => {
      const root = document.querySelector(".voicepaste-checklist");
      const panel = root?.querySelector(".driver-checklist-panel");
      if (!panel) return;
      root
        ?.querySelector(".driver-checklist-close-btn")
        ?.setAttribute("aria-label", t("ui.onboarding.collapse"));
      for (const task of TASKS) {
        const row = root?.querySelector(`[data-item-id="${task}"]`);
        const title = row?.querySelector(".driver-checklist-item-title");
        if (title) title.textContent = label(task);
        const status = row?.querySelector(".driver-checklist-sr-only");
        if (status) {
          status.textContent =
            completed.current.has(task) && !(task === "llm" && skipped.current)
              ? ` (${t("ui.onboarding.reviewed")})`
              : "";
        }
      }
      let footer = panel.querySelector<HTMLButtonElement>(".onboarding-exit");
      if (!footer) {
        footer = document.createElement("button");
        footer.type = "button";
        footer.className = "onboarding-exit";
        footer.addEventListener("click", () => void exitRef.current());
        panel.appendChild(footer);
      }
      footer.textContent = t(
        completed.current.size === TASKS.length ? "ui.onboarding.finish" : "ui.onboarding.exit",
      );
    };
    const restore = () => {
      if (disposed || suppressRestore) return;
      widget.show();
      widget.open();
      decorate();
    };
    const stop = () => {
      pending?.abort();
      pending = null;
      current.current = null;
      tour.current?.destroy();
      tour.current = null;
      modalPaused = false;
      restore();
    };
    cancel.current = stop;

    const run = async (task: TaskId, index = 0) => {
      pending?.abort();
      const controller = new AbortController();
      pending = controller;
      suppressRestore = true;
      tour.current?.destroy();
      tour.current = null;
      suppressRestore = false;
      current.current = { task, index };
      widget.hide();
      navigate(TASK_SECTION[task]);
      const steps = getSteps(task, isMac, t);
      const definition = steps[index];
      try {
        const target = await waitForTarget(definition.element as string, controller.signal);
        if (disposed || controller.signal.aborted) return;
        // Use the actual resolved element; a missing target must never silently complete a task.
        definition.element = target;
        if (task === "asr" && index === 1) {
          const key =
            target.getAttribute("data-model-kind") === "offline" ? "asrOffline" : "asrOnline";
          definition.popover = {
            ...definition.popover,
            title: t(`ui.onboarding.steps.${key}.title`),
            description: t(`ui.onboarding.steps.${key}.description`),
          };
        }
        const instance = driver({
          steps,
          animate: !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
          overlayClickBehavior: "none",
          allowKeyboardControl: task !== "hotkey",
          popoverClass: "voicepaste-tour",
          nextBtnText: t("ui.onboarding.next"),
          prevBtnText: t("ui.onboarding.previous"),
          doneBtnText: t("ui.onboarding.completeTask"),
          closeBtnLabel: t("ui.onboarding.backToChecklist"),
          showButtons: ["next", "previous", "close"],
          onNextClick: () => void run(task, index + 1),
          onPrevClick: () => void run(task, index - 1),
          onDoneClick: () => {
            completed.current.add(task);
            if (task === "llm") skipped.current = false;
            widget.complete(task);
            stop();
          },
          onDestroyed: () => {
            if (!suppressRestore && !disposed) {
              current.current = null;
              tour.current = null;
              restore();
            }
          },
          onPopoverRender: (popover) => {
            popover.previousButton.disabled = index === 0;
            // Each substep runs independently so async navigation can be cancelled safely.
            popover.nextButton.textContent = t(
              index === steps.length - 1 ? "ui.onboarding.completeTask" : "ui.onboarding.next",
            );
            if (task === "llm") {
              const skip = document.createElement("button");
              skip.type = "button";
              skip.className = "onboarding-skip";
              skip.textContent = t("ui.onboarding.skip");
              skip.addEventListener("click", () => {
                skipped.current = true;
                completed.current.add(task);
                widget.complete(task);
                stop();
              });
              popover.footerButtons.prepend(skip);
            }
          },
        });
        tour.current = instance;
        instance.drive(index);
      } catch {
        if (!disposed && !controller.signal.aborted) {
          current.current = null;
          showToast(t("ui.onboarding.targetError"), "error");
          restore();
        }
      }
    };

    const widget = checklist({
      id: "voicepaste-setup",
      className: "voicepaste-checklist checklist-compact",
      title: t("ui.onboarding.title"),
      launcherText: t("ui.onboarding.title"),
      completeTitle: t("ui.onboarding.completeTitle"),
      completeDescription: t("ui.onboarding.completeDescription"),
      completeLauncherText: t("ui.onboarding.completeTitle"),
      progressText: t("ui.onboarding.progress", { done: "{{done}}", total: "{{total}}" }),
      launcherProgressText: "{{done}}/{{total}}",
      position: "bottom-right",
      completed: [...completed.current],
      allowManualComplete: false,
      items: TASKS.map((task) => ({
        id: task,
        title: label(task),
        action: () => void run(task),
        completeWhen: () => completed.current.has(task),
      })),
      onEvent: decorate,
    });
    list.current = widget;
    restore();
    if (resume) void run(resume.task, resume.index);

    // Existing settings dialogs temporarily own focus and Escape; resume after they close.
    const observer = new MutationObserver(() => {
      const dialogOpen = !!document.querySelector("[data-settings-dialog]");
      if (dialogOpen && tour.current && !modalPaused) {
        modalPaused = true;
        suppressRestore = true;
        tour.current.destroy();
        tour.current = null;
        suppressRestore = false;
      } else if (!dialogOpen && modalPaused) {
        modalPaused = false;
        const saved = current.current;
        if (saved) void run(saved.task, saved.index);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const onEscape = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        current.current?.task === "hotkey" &&
        !document.querySelector("[data-hotkey-recording]")
      )
        stop();
    };
    window.addEventListener("keydown", onEscape);

    return () => {
      disposed = true;
      pending?.abort();
      observer.disconnect();
      window.removeEventListener("keydown", onEscape);
      tour.current?.destroy();
      tour.current = null;
      widget.hide();
      list.current = null;
      cancel.current = () => {};
    };
  }, [active, isMac, navigate, showToast, t]);

  return {
    start,
    cancelTour: () => cancel.current(),
    overlay: (
      <>
        <Modal
          open={welcome}
          title={t("ui.onboarding.welcomeTitle")}
          closeLabel={t("ui.onboarding.dismiss")}
          onClose={() => {
            if (!saving) void dismissInvitation();
          }}
        >
          <div data-onboarding-welcome>
            <p>{t("ui.onboarding.welcomeDescription")}</p>
            <div className="mt-5 flex justify-end gap-2">
              <Button disabled={saving} onClick={() => void dismissInvitation()}>
                {t("ui.onboarding.dismiss")}
              </Button>
              <Button variant="accent" disabled={saving} onClick={() => void start()}>
                {t("ui.onboarding.start")}
              </Button>
            </div>
          </div>
        </Modal>
        <div role="status" aria-live="polite">
          <Toast toast={toast} />
        </div>
      </>
    ),
  };
}
