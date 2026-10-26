import { NextRequest } from "next/server"
import { isLocale } from "@/lib/i18n"
import { getReleaseRecords } from "@/lib/releases"

export function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams
  const lang = params.get("lang") ?? "en"
  if (!isLocale(lang))
    return Response.json({ error: "lang must be en or zh" }, { status: 400 })
  const version = params.get("version")
  const releases = getReleaseRecords(lang, version ?? undefined)
  if (version !== null && releases.length === 0)
    return Response.json({ error: "Release not found" }, { status: 404 })
  return Response.json(
    { releases },
    { headers: { "Cache-Control": "public, max-age=300, s-maxage=300" } }
  )
}
