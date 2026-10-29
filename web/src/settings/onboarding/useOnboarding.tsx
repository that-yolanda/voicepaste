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

type InlineGuide = {
  task: TaskId;
  index: number;
  key: string;
  previous: () => void;
  next: () => void;
  close: () => void;
};

export function useOnboarding(navigate: (section: SectionId) => void) {
  const { t } = useTranslation();
  const { config, settings, loading, scheduleSave } = useSettings();
  const [active, setActive] = useState(false);
  const [welcomeClosed, setWelcomeClosed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [guide, setGuide] = useState<InlineGuide | null>(null);
  const [guideCollapsed, setGuideCollapsed] = useState(false);
  const guideHeading = useRef<HTMLHeadingElement>(null);
  const completed = useRef(new Set<TaskId>());
  const skipped = useRef(false);
  const current = useRef<{ task: TaskId; index: number } | null>(null);
  const tour = useRef<Driver | null>(null);
  const list = useRef<Checklist | null>(null);
  const cancel = useRef<() => void>(() => {});
  const { toast, showToast } = useToast();
  const isMac = settings?.runtime?.platform === "macos";
  const welcome = !loading && config?.app?.onboarding_pending === true && !welcomeClosed;

  const guideStep = guide ? `${guide.task}-${guide.index}` : null;
  useEffect(() => {
    if (!guideStep) return;
    setGuideCollapsed(false);
    guideHeading.current?.focus({ preventScroll: true });
  }, [guideStep]);

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
    let inlineActive = false;
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
      document.body.classList.remove("voicepaste-tour-interactive");
      tour.current = null;
      modalPaused = false;
      inlineActive = false;
      setGuide(null);
      restore();
    };
    cancel.current = stop;

    const voiceMode = () =>
      document.querySelector('[data-tour="hotkey-voice-mode"]')?.getAttribute("data-voice-mode") ??
      "toggle";
    const run = async (task: TaskId, index = 0) => {
      pending?.abort();
      const controller = new AbortController();
      pending = controller;
      inlineActive = false;
      setGuide(null);
      suppressRestore = true;
      tour.current?.destroy();
      document.body.classList.remove("voicepaste-tour-interactive");
      tour.current = null;
      suppressRestore = false;
      current.current = { task, index };
      widget.hide();
      navigate(TASK_SECTION[task]);
      const steps = getSteps(task, isMac, t, voiceMode());
      const definition = steps[index];
      try {
        const target = await waitForTarget(definition.element as string, controller.signal);
        if (disposed || controller.signal.aborted) return;
        // Use the actual resolved element; a missing target must never silently complete a task.
        definition.element = target;
        const complete = () => {
          completed.current.add(task);
          if (task === "llm") skipped.current = false;
          widget.complete(task);
          stop();
        };
        const skip = () => {
          skipped.current = true;
          completed.current.add(task);
          widget.complete(task);
          stop();
        };
        // Configuration needs the full page, including tabs and the scroll container.
        if (task === "asr" && index === 1) {
          inlineActive = true;
          setGuide({
            task,
            index,
            key: target.getAttribute("data-model-kind") === "offline" ? "asrOffline" : "asrOnline",
            previous: () => void run(task, index - 1),
            next: index === steps.length - 1 ? complete : () => void run(task, index + 1),
            close: stop,
          });
          return;
        }
        const move = (direction: number) => {
          let next = index + direction;
          if (task === "hotkey" && next === 4 && voiceMode() === "hold") next += direction;
          void run(task, next);
        };
        if (task === "llm" || task === "hotkey") {
          document.body.classList.add("voicepaste-tour-interactive");
        }
        const instance = driver({
          steps,
          animate: !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
          overlayClickBehavior: "none",
          allowKeyboardControl: task !== "hotkey" && task !== "llm",
          ...(task === "llm" ? { overlayOpacity: 0.35 } : {}),
          popoverClass: "voicepaste-tour",
          nextBtnText: t("ui.onboarding.next"),
          prevBtnText: t("ui.onboarding.previous"),
          doneBtnText: t("ui.onboarding.completeTask"),
          closeBtnLabel: t("ui.onboarding.backToChecklist"),
          showButtons: ["next", "previous", "close"],
          onNextClick: () => move(1),
          onPrevClick: () => move(-1),
          onDoneClick: complete,
          onDestroyed: () => {
            document.body.classList.remove("voicepaste-tour-interactive");
            if (!suppressRestore && !disposed) {
              current.current = null;
              tour.current = null;
              restore();
            }
          },
          onPopoverRender: (popover) => {
            popover.title.tabIndex = -1;
            // Run after Driver.js's synchronous close-button autofocus, before the next paint.
            queueMicrotask(() => {
              if (disposed || controller.signal.aborted || modalPaused || !target.isConnected)
                return;
              const control = target.querySelector<HTMLElement>(
                "select:not(:disabled), input:not(:disabled), textarea:not(:disabled), button:not(:disabled), a[href]",
              );
              const focus =
                task === "hotkey" && index === 0 ? popover.title : (control ?? popover.title);
              focus.focus({ preventScroll: true });
            });
            popover.previousButton.disabled = index === 0;
            // Each substep runs independently so async navigation can be cancelled safely.
            popover.nextButton.textContent = t(
              index === steps.length - 1 ? "ui.onboarding.completeTask" : "ui.onboarding.next",
            );
            if (task === "llm") {
              const button = document.createElement("button");
              button.type = "button";
              button.className = "onboarding-skip";
              button.textContent = t("ui.onboarding.skip");
              button.addEventListener("click", skip);
              popover.footerButtons.prepend(button);
            }
          },
        });
        tour.current = instance;
        instance.drive(index);
      } catch {
        document.body.classList.remove("voicepaste-tour-interactive");
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
      completeTitle: t("ui.onboarding.title"),
      completeDescription: "",
      completeLauncherText: t("ui.onboarding.title"),
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
    const observer = new MutationObserver((records) => {
      const dialogOpen = !!document.querySelector("[data-settings-dialog]");
      if (dialogOpen && (tour.current || inlineActive) && !modalPaused) {
        modalPaused = true;
        inlineActive = false;
        setGuide(null);
        suppressRestore = true;
        tour.current?.destroy();
        document.body.classList.remove("voicepaste-tour-interactive");
        tour.current = null;
        suppressRestore = false;
      } else if (!dialogOpen && modalPaused) {
        modalPaused = false;
        const saved = current.current;
        if (saved) void run(saved.task, saved.index);
      } else if (
        !dialogOpen &&
        current.current?.task === "hotkey" &&
        (current.current.index === 3 || current.current.index === 4) &&
        records.some((record) => record.attributeName === "data-voice-mode")
      ) {
        void run("hotkey", 3);
      } else if (inlineActive && current.current?.task === "asr") {
        const key =
          document.querySelector('[data-tour="asr-models"]')?.getAttribute("data-model-kind") ===
          "offline"
            ? "asrOffline"
            : "asrOnline";
        setGuide((previous) =>
          previous && previous.key !== key ? { ...previous, key } : previous,
        );
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-model-kind", "data-voice-mode"],
    });
    const onEscape = (event: KeyboardEvent) => {
      if (document.querySelector("[data-settings-dialog]")) return;
      if (
        event.key === "Escape" &&
        (inlineActive || current.current?.task === "hotkey" || current.current?.task === "llm") &&
        !document.querySelector("[data-hotkey-recording]")
      )
        stop();
    };
    window.addEventListener("keydown", onEscape);

    return () => {
      disposed = true;
      setGuide(null);
      pending?.abort();
      observer.disconnect();
      window.removeEventListener("keydown", onEscape);
      tour.current?.destroy();
      document.body.classList.remove("voicepaste-tour-interactive");
      tour.current = null;
      widget.hide();
      list.current = null;
      cancel.current = () => {};
    };
  }, [active, isMac, navigate, showToast, t]);

  return {
    start,
    cancelTour: () => cancel.current(),
    guide: guide && (
      <div className="pointer-events-none absolute inset-0 z-20 overflow-hidden p-4 pr-6">
        <section
          className="onboarding-guide pointer-events-auto ml-auto max-h-full w-full max-w-sm overflow-y-auto rounded-xl border border-border bg-surface-card p-4 text-text shadow-lg"
          aria-labelledby="onboarding-guide-title"
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            <h2
              id="onboarding-guide-title"
              ref={guideHeading}
              tabIndex={-1}
              className="font-semibold"
            >
              {t(`ui.onboarding.steps.${guide.key}.title`)}
            </h2>
            <button
              type="button"
              className="text-xs text-text-dim hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
              aria-expanded={!guideCollapsed}
              aria-controls="onboarding-guide-details"
              onClick={() => setGuideCollapsed((collapsed) => !collapsed)}
            >
              {t(guideCollapsed ? "ui.onboarding.expandGuide" : "ui.onboarding.collapseGuide")}
            </button>
          </div>
          <div id="onboarding-guide-details" hidden={guideCollapsed}>
            <p className="mt-2 text-sm text-text-dim">
              {t(`ui.onboarding.steps.${guide.key}.description`)}
            </p>
            <div className="mt-3 flex flex-wrap justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={guide.close}>
                {t("ui.onboarding.backToChecklist")}
              </Button>
              <Button size="sm" disabled={guide.index === 0} onClick={guide.previous}>
                {t("ui.onboarding.previous")}
              </Button>
              <Button size="sm" variant="accent" onClick={guide.next}>
                {t(guide.index === 1 ? "ui.onboarding.completeTask" : "ui.onboarding.next")}
              </Button>
            </div>
          </div>
        </section>
      </div>
    ),
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
