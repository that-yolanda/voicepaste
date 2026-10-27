import Link from "next/link"
import Image from "next/image"
import { notFound } from "next/navigation"
import { ArrowUpRight } from "lucide-react"
import { FeedbackForm } from "@/components/feedback-form"
import { feedbackCopy } from "@/lib/feedback-copy"
import { isLocale } from "@/lib/i18n"
import { pageMetadata } from "@/lib/seo"

type Props = { params: Promise<{ lang: string }> }

export async function generateMetadata({ params }: Props) {
  const { lang } = await params
  if (!isLocale(lang)) notFound()
  const copy = feedbackCopy[lang]
  return pageMetadata(lang, "/feedback", copy.heading, copy.intro)
}

export default async function FeedbackPage({ params }: Props) {
  const { lang } = await params
  if (!isLocale(lang)) notFound()
  const copy = feedbackCopy[lang]
  return (
    <main id="main" className="wrap py-10 md:py-14">
      <div className="grid gap-10 min-[1100px]:grid-cols-[minmax(0,1fr)_minmax(0,672px)] min-[1100px]:gap-16">
        <div className="mx-auto w-full max-w-2xl self-start min-[1100px]:sticky min-[1100px]:top-28 min-[1100px]:mx-0">
          <h1 className="page-title">{copy.heading}</h1>
          <p className="mt-3 max-w-md text-base leading-7 text-foreground/70">
            {copy.intro}
          </p>
          <Image
            src="/assets/illustrations/feedback.png"
            alt=""
            width={1280}
            height={1280}
            sizes="(min-width: 1100px) 480px, 1px"
            className="mt-12 hidden w-full max-w-[480px] min-[1100px]:block"
          />
        </div>
        <div className="mx-auto w-full max-w-2xl min-w-0">
          <noscript>
            <p className="mb-5 rounded-lg bg-muted p-4 text-sm">
              {lang === "zh"
                ? "提交表单需要启用 JavaScript。你也可以使用页面下方的 GitHub Issues 入口。"
                : "Enable JavaScript to submit this form, or use the GitHub Issues link below."}
            </p>
          </noscript>
          <FeedbackForm locale={lang} />
          <p className="mt-7 text-center text-sm leading-relaxed text-foreground/70">
            {copy.githubBefore}
            <Link
              href="https://github.com/that-yolanda/voicepaste/issues"
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-h-11 items-center gap-1 font-medium text-foreground underline underline-offset-4"
            >
              Issue
              <ArrowUpRight aria-hidden="true" className="size-3.5" />
            </Link>
            {copy.githubAfter}
          </p>
        </div>
      </div>
    </main>
  )
}
