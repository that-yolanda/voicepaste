import { NextRequest, NextResponse } from "next/server"
import { detectLocale, localeCookie } from "@/lib/i18n"
export function proxy(request: NextRequest) {
  const locale = detectLocale(
    request.headers.get("accept-language"),
    request.cookies.get(localeCookie)?.value
  )
  const destination = request.nextUrl.clone()
  destination.pathname = `/${locale}${destination.pathname === "/" ? "" : destination.pathname}`
  const response = NextResponse.redirect(destination, 308)
  response.headers.set("Vary", "Accept-Language, Cookie")
  response.headers.set("Cache-Control", "private, no-store")
  return response
}
export const config = {
  matcher: ["/", "/docs/:path*", "/downloads", "/feedback"],
}
