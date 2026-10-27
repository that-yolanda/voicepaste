import type { MetadataRoute } from "next"
import { siteUrl } from "@/lib/seo"
import { source } from "@/lib/source"
export default function sitemap(): MetadataRoute.Sitemap {
  const paths = [
    "",
    "/downloads",
    "/feedback",
    ...source
      .getPages("en")
      .map((p) => "/docs" + (p.slugs.length ? "/" + p.slugs.join("/") : "")),
  ]
  return ["en", "zh"].flatMap((locale) =>
    paths.map((path) => ({
      url: `${siteUrl}/${locale}${path}`,
      alternates: {
        languages: {
          en: `${siteUrl}/en${path}`,
          "zh-CN": `${siteUrl}/zh${path}`,
        },
      },
    }))
  )
}
