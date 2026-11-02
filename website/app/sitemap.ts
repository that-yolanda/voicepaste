import type { MetadataRoute } from "next"
import { siteUrl } from "@/lib/seo"
import { source } from "@/lib/source"
import { latest } from "@/lib/releases"

export default function sitemap(): MetadataRoute.Sitemap {
  const entries = [
    { path: "", lastModified: latest.date },
    { path: "/downloads", lastModified: latest.date },
    // The feedback page is mostly static; no lastModified.
    { path: "/feedback" },
    ...source.getPages("en").map((p) => ({
      path: "/docs" + (p.slugs.length ? "/" + p.slugs.join("/") : ""),
      lastModified: p.data.lastModified,
    })),
  ]
  return ["en", "zh"].flatMap((locale) =>
    entries.map((entry) => ({
      url: `${siteUrl}/${locale}${entry.path}`,
      lastModified: entry.lastModified,
      alternates: {
        languages: {
          en: `${siteUrl}/en${entry.path}`,
          "zh-CN": `${siteUrl}/zh${entry.path}`,
        },
      },
    }))
  )
}
