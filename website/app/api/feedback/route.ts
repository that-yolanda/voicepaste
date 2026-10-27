import { handleFeedback } from "@/lib/feedback-server"

export const runtime = "nodejs"

export async function POST(request: Request) {
  return handleFeedback(request, {
    apiKey: process.env.RESEND_API_KEY,
    from: process.env.FEEDBACK_FROM,
    to: process.env.FEEDBACK_TO,
    siteUrl: process.env.NEXT_PUBLIC_SITE_URL,
  })
}
