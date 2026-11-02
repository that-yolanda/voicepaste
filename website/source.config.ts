import { defineDocs, defineConfig } from "fumadocs-mdx/config"
export const docs = defineDocs({
  dir: "content/docs",
  docs: {
    // Expose each page's last git commit time as `page.data.lastModified`.
    // On Vercel, set VERCEL_DEEP_CLONE=true so git history is available.
    lastModified: true,
  },
})
export default defineConfig()
