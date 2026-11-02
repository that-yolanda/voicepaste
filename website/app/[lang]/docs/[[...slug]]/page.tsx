import type { Metadata } from "next"
import { source } from "@/lib/source"
import { notFound } from "next/navigation"
import { ViewTransition } from "react"
import { isLocale } from "@/lib/i18n"
import { faqJsonLd, pageMetadata } from "@/lib/seo"
import { DocsBody, DocsPage, DocsTitle } from "fumadocs-ui/page"
import defaultMdxComponents from "fumadocs-ui/mdx"
type Props = { params: Promise<{ lang: string; slug?: string[] }> }
export function generateStaticParams() {
  return source.generateParams()
}
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { lang, slug = [] } = await params
  if (!isLocale(lang)) notFound()
  const page = source.getPage(slug, lang)
  if (!page) notFound()
  return pageMetadata(
    lang,
    "/docs" + (slug.length ? "/" + slug.join("/") : ""),
    page.data.title,
    page.data.description ??
      (lang === "zh"
        ? "VoicePaste 配置文档：安装、权限、识别模型与润色模板。"
        : "VoicePaste guides for setup, permissions, speech models, and templates.")
  )
}
export default async function Page({ params }: Props) {
  const { lang, slug = [] } = await params
  const page = source.getPage(slug, lang)
  if (!page) notFound()
  const MDX = page.data.body
  const isFaqPage = isLocale(lang) && slug.length === 1 && slug[0] === "faq"
  return (
    <>
      {isFaqPage && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(faqJsonLd(lang)),
          }}
        />
      )}
      <ViewTransition
        key={page.url}
        enter="page-fade"
        exit="page-fade"
        default="none"
      >
        <DocsPage
          toc={page.data.toc}
          full={page.data.full}
          className="max-w-none"
        >
          <DocsTitle>{page.data.title}</DocsTitle>
          <DocsBody>
            <MDX components={defaultMdxComponents} />
          </DocsBody>
        </DocsPage>
      </ViewTransition>
    </>
  )
}
