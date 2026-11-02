"use client"
import { useEffect, useRef, useState, type RefObject } from "react"
import { Check } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { Locale } from "@/lib/i18n"
import { examples } from "@/lib/scenarios"

// One clock per visible demo; all timers and observers are released on navigation.
function useDemoClock(ref: RefObject<HTMLElement | null>, duration: number) {
  const [clock, setClock] = useState({ time: 0, running: false, reduced: true })
  const [restart, setRestart] = useState(0)
  useEffect(() => {
    const node = ref.current
    if (!node) return
    const motion = matchMedia("(prefers-reduced-motion: reduce)")
    let visible = false
    let timer: ReturnType<typeof setInterval> | undefined
    const stop = () => {
      clearInterval(timer)
      timer = undefined
    }
    const sync = () => {
      stop()
      const running = visible && !document.hidden && !motion.matches
      setClock({ time: 0, running, reduced: motion.matches })
      if (!running) return
      const start = performance.now()
      timer = setInterval(
        () =>
          setClock({
            time: (performance.now() - start) % duration,
            running: true,
            reduced: false,
          }),
        70
      )
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        visible = entry.isIntersecting
        sync()
      },
      { threshold: 0.25 }
    )
    observer.observe(node)
    document.addEventListener("visibilitychange", sync)
    motion.addEventListener("change", sync)
    return () => {
      stop()
      observer.disconnect()
      document.removeEventListener("visibilitychange", sync)
      motion.removeEventListener("change", sync)
    }
  }, [duration, restart, ref])
  return { ...clock, restart: () => setRestart((value) => value + 1) }
}
function typed(text: string, elapsed: number, duration = 2400) {
  return text.slice(
    0,
    Math.max(
      0,
      Math.min(text.length, Math.ceil((text.length * elapsed) / duration))
    )
  )
}
function Waveform() {
  return (
    <span className="waveform" aria-hidden="true">
      <i />
      <i />
      <i />
      <i />
    </span>
  )
}
function SoundRipple({ left = false }: { left?: boolean }) {
  return (
    <svg
      className={`sound-ripple ${left ? "sound-ripple-left" : ""}`}
      viewBox="0 0 32 56"
      fill="none"
      aria-hidden="true"
    >
      <path d="M4 20 A12 12 0 0 1 4 36" />
      <path d="M11 12 A24 24 0 0 1 11 44" />
      <path d="M18 4 A36 36 0 0 1 18 52" />
    </svg>
  )
}
function Pill({
  children,
  phase = "recording",
}: {
  children: string
  phase?: "recording" | "processing" | "complete"
}) {
  const confirmed =
    phase === "recording" ? Math.max(0, children.length - 6) : children.length
  return (
    <div className="voice-pill" data-ui data-phase={phase}>
      {phase === "recording" && <Waveform />}
      {phase === "complete" && (
        <Check className="size-4 shrink-0" aria-hidden="true" />
      )}
      <span className="pill-transcript">
        <span>{children.slice(0, confirmed)}</span>
        <span className="opacity-55">{children.slice(confirmed)}</span>
      </span>
    </div>
  )
}
const modes = ["input", "translate", "polish"] as const
export function ScenarioDemo({ locale }: { locale: Locale }) {
  const ref = useRef<HTMLDivElement>(null)
  const clock = useDemoClock(ref, 24000)
  const [base, setBase] = useState(0)
  const index = (base + (clock.running ? Math.floor(clock.time / 8000) : 0)) % 3
  const mode = modes[index]
  const data = examples[mode][locale]
  const elapsed = clock.time % 8000
  const phase =
    clock.reduced || !clock.running
      ? "complete"
      : elapsed < 4000
        ? "recording"
        : elapsed < 4800
          ? "processing"
          : "complete"
  const en = locale === "en"
  const output = phase === "complete" ? data[5] : ""
  const transcript =
    phase === "recording"
      ? typed(data[4], elapsed, 3200)
      : phase === "processing"
        ? en
          ? "Preparing your text…"
          : "整理中…"
        : en
          ? "Text delivered"
          : "输入完成"
  return (
    <section
      ref={ref}
      id="scenarios"
      className="wrap section-space"
      aria-labelledby="scenarios-title"
    >
      <div className="mb-10 flex flex-wrap items-end justify-between gap-8">
        <h2 id="scenarios-title" className="reveal text-head">
          {en ? "One thought. Many ways to write." : "一句口述，多种表达。"}
        </h2>
        <div
          className="flex flex-wrap gap-2"
          role="tablist"
          aria-label={en ? "Writing mode" : "表达方式"}
        >
          {modes.map((item, i) => (
            <Button
              key={item}
              id={`tab-${item}`}
              role="tab"
              variant={index === i ? "default" : "ghost"}
              className="min-h-11 px-4"
              aria-selected={index === i}
              aria-controls="scenario-panel"
              tabIndex={index === i ? 0 : -1}
              onClick={() => {
                setBase(i)
                clock.restart()
              }}
              onKeyDown={(event) => {
                let next: number
                if (event.key === "ArrowRight") next = (i + 1) % 3
                else if (event.key === "ArrowLeft") next = (i + 2) % 3
                else if (event.key === "Home") next = 0
                else if (event.key === "End") next = 2
                else return
                event.preventDefault()
                setBase(next)
                clock.restart()
                document.getElementById(`tab-${modes[next]}`)?.focus()
              }}
            >
              {
                (en
                  ? ["Voice input", "Translate", "Polish"]
                  : ["语音输入", "翻译", "文本润色"])[i]
              }
            </Button>
          ))}
        </div>
      </div>
      <div
        className="grid items-center gap-10 lg:grid-cols-[.7fr_1.3fr] lg:gap-16"
        id="scenario-panel"
        role="tabpanel"
        aria-labelledby={`tab-${mode}`}
      >
        <div>
          <h3 className="text-lead">{data[2]}</h3>
          <p className="mt-5 max-w-sm">{data[3]}</p>
        </div>
        <div
          className={`relative flex min-h-[430px] flex-col items-center justify-center gap-7 overflow-hidden rounded-[24px] bg-muted p-8 max-sm:min-h-[400px] max-sm:px-5 ${phase === "recording" && clock.running ? "is-running" : ""}`}
          data-ui
          data-phase={phase}
        >
          <div className="writing-window w-full max-w-lg">
            <div className="window-top flex items-center justify-between gap-4">
              <span className="window-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <span>{data[0]}</span>
              <span aria-hidden="true">···</span>
            </div>
            <div className="min-h-[170px] px-7 py-6">
              <p className="mb-4 font-medium">{data[1]}</p>
              <p className="leading-relaxed whitespace-pre-line">{output}</p>
            </div>
          </div>
          <Pill phase={phase}>{transcript}</Pill>
        </div>
      </div>
    </section>
  )
}
export function SoundDemo({ locale }: { locale: Locale }) {
  const ref = useRef<HTMLDivElement>(null)
  const clock = useDemoClock(ref, 7000)
  const en = locale === "en"
  const phase = !clock.running
    ? "complete"
    : clock.time < 1600
      ? "processing"
      : clock.time < 4600
        ? "recording"
        : "complete"
  const text =
    phase === "processing"
      ? en
        ? "Preparing…"
        : "准备中"
      : phase === "recording"
        ? en
          ? "Recording…"
          : "正在聆听"
        : en
          ? "Text delivered"
          : "输入完成"
  const cue = phase !== "recording"
  return (
    <article ref={ref} className="feature-card" id="sound-feature">
      <h3 className="text-lead">
        {en ? "Hear when it happens." : "每次输入，都有回应。"}
      </h3>
      <p className="mt-4">
        {en
          ? "A clear sound when recording starts and your text is ready."
          : "开始录音、完成输入，用声音给你明确回应。"}
      </p>
      <div
        className={`feature-canvas cue-canvas ${clock.running ? "is-running" : ""}`}
        data-ui
        data-phase={phase}
      >
        <div
          className={`flex w-full items-center justify-center gap-2 ${cue ? "cue-active" : ""}`}
        >
          <SoundRipple left />
          <Pill phase={phase}>{text}</Pill>
          <SoundRipple />
        </div>
        <p className="text-center text-[13px] leading-[1.7] text-muted-foreground">
          {en ? "A cue to start. A cue when done." : "开始有提示，完成有回应。"}
        </p>
      </div>
    </article>
  )
}

export function TemplateChoiceDemo({ locale }: { locale: Locale }) {
  const ref = useRef<HTMLDivElement>(null)
  const clock = useDemoClock(ref, 10000)
  const en = locale === "en"
  const elapsed = clock.time
  const complete = !clock.running || elapsed >= 7600
  const choosing = clock.running && elapsed >= 6000 && elapsed < 6600
  const processing = clock.running && elapsed >= 6600 && elapsed < 7600
  const showHints = !clock.running || elapsed >= 5000
  const raw = en
    ? "The designs are ready, let's review them tomorrow."
    : "设计稿好了，明天一起过一下吧。"
  const text = complete
    ? en
      ? "The designs are ready. Let’s review them tomorrow."
      : "设计稿已完成，邀请大家明天一起评审。"
    : processing
      ? en
        ? "Polishing…"
        : "润色中…"
      : typed(raw, elapsed, 3000)
  return (
    <article ref={ref} className="feature-card" id="template-choice-feature">
      <h3 className="text-lead">
        {en ? "Speak first. Choose how to write." : "先说，再选怎么表达。"}
      </h3>
      <p className="mt-4">
        {en
          ? "Get your thoughts out, then finish with the original text or a translation or polishing template."
          : "先把想法说出来，说完再决定直接输入，还是用模板翻译、润色。"}
      </p>
      <div
        className={`feature-canvas choice-canvas ${clock.running && !processing && !complete ? "is-running" : ""}`}
        data-ui
      >
        <div
          className={`demo-shortcuts ${showHints ? "shortcuts-visible" : ""}`}
          aria-hidden="true"
        >
          <span>
            <kbd>Esc</kbd>
            {en ? "Cancel" : "取消"}
          </span>
          <span>
            <kbd>Fn</kbd>
            {en ? "Finish" : "完成"}
          </span>
          <span className={choosing ? "shortcut-pressed" : ""}>
            <kbd>Fn + 1</kbd>
            {en ? "Polish" : "润色"}
          </span>
        </div>
        <Pill
          phase={
            complete ? "complete" : processing ? "processing" : "recording"
          }
        >
          {text}
        </Pill>
        <p className="text-center text-[13px] leading-[1.7] text-muted-foreground">
          {en
            ? "Example keys. Every shortcut is customizable."
            : "按键仅为示例，快捷键均可自定义。"}
        </p>
      </div>
    </article>
  )
}

export function StreamDemo({ locale }: { locale: Locale }) {
  const ref = useRef<HTMLDivElement>(null)
  const clock = useDemoClock(ref, 6500)
  const en = locale === "en"
  const text = en
    ? "Give each thought a little room to become clear."
    : "把脑海里的想法，一点点说清楚。"
  return (
    <article ref={ref} className="feature-card" id="stream-feature">
      <h3 className="text-lead">
        {en
          ? "Streaming text, as you speak."
          : "流式输出，说到哪里，看到哪里。"}
      </h3>
      <p className="mt-4">
        {en
          ? "With a model that supports live preview, your transcript appears as you speak."
          : "支持实时预览的识别模型，让转写逐步呈现。"}
      </p>
      <div className="feature-canvas stream-canvas" data-ui>
        <p className="text-[26px] leading-[1.6] max-lg:text-2xl">
          {clock.running ? typed(text, clock.time, 3200) : text}
        </p>
      </div>
    </article>
  )
}
export function AutoVideo({ locale }: { locale: Locale }) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const video = ref.current
    if (!video) return
    let visible = false
    const motion = matchMedia("(prefers-reduced-motion: reduce)")
    const sync = () => {
      if (!visible || document.hidden || motion.matches) video.pause()
      else void video.play().catch(() => {})
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        visible = entry.isIntersecting
        sync()
      },
      { threshold: 0.25 }
    )
    observer.observe(video)
    document.addEventListener("visibilitychange", sync)
    motion.addEventListener("change", sync)
    return () => {
      observer.disconnect()
      video.pause()
      document.removeEventListener("visibilitychange", sync)
      motion.removeEventListener("change", sync)
    }
  }, [locale])
  return (
    <video
      key={locale}
      id="demo"
      ref={ref}
      className="reveal mx-auto mt-12 block aspect-video h-auto w-full max-w-5xl rounded-2xl object-contain"
      width={1920}
      height={1080}
      poster={`/assets/demo-${locale}-poster.jpg`}
      preload="metadata"
      muted
      controls
      loop
      playsInline
      aria-label={
        locale === "en"
          ? "VoicePaste dictation, translation and polishing demo"
          : "VoicePaste 语音输入、翻译与润色演示"
      }
    >
      <source src={`/assets/demo-${locale}.mp4`} type="video/mp4" />
    </video>
  )
}
export function RevealObserver() {
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries)
          if (entry.isIntersecting) {
            entry.target.classList.add("arrived")
            observer.unobserve(entry.target)
          }
      },
      { threshold: 0.08 }
    )
    document
      .querySelectorAll(".reveal")
      .forEach((node) => observer.observe(node))
    return () => observer.disconnect()
  }, [])
  return null
}

export function LanguageDemo({ locale }: { locale: Locale }) {
  const ref = useRef<HTMLDivElement>(null)
  const clock = useDemoClock(ref, 8500)
  const en = locale === "en"
  const text = "这个版本的 API，我想再 review 一下。"
  return (
    <article ref={ref} className="feature-card">
      <div className="feature-copy">
        <h3 className="text-lead">
          {en ? "Speak your own way." : "按习惯说。"}
        </h3>
        <p className="mt-4">
          {en
            ? "Mix Chinese and English, or choose a model for the languages you use."
            : "中英混说、多语言识别，选择适合你的模型。"}
        </p>
      </div>
      <div className="feature-canvas language-canvas" data-ui>
        <div className="language-fragments" aria-hidden="true">
          <span className={clock.time < 4000 ? "language-active" : ""}>
            你好
          </span>
          <span className={clock.time >= 4000 ? "language-active" : ""}>
            Hello
          </span>
        </div>
        <p className="language-output" lang="zh-CN">
          {clock.running ? typed(text, clock.time, 3500) : text}
        </p>
      </div>
    </article>
  )
}
