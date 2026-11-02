import { ImageResponse } from "next/og"
const size = { width: 1200, height: 630 }
export function GET(request: Request) {
  // With ?title= the card shows the page headline (Latin scripts only —
  // other scripts would render as tofu without an embedded font).
  // Without it, the card falls back to the brand tagline.
  const title = new URL(request.url).searchParams.get("title")?.slice(0, 80)
  const headline = title ? (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        fontSize: 60,
        lineHeight: 1.15,
        maxWidth: 1040,
      }}
    >
      {title}
    </div>
  ) : (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        fontSize: 76,
        lineHeight: 1.1,
      }}
    >
      <span>Think freely.</span>
      <span>Speak naturally.</span>
    </div>
  )
  return new ImageResponse(
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        width: "100%",
        height: "100%",
        padding: 80,
        background: "#20231e",
        color: "#fafaf8",
        fontFamily: "sans-serif",
      }}
    >
      <div style={{ fontSize: 36 }}>VoicePaste</div>
      {headline}
      <div style={{ fontSize: 26 }}>Free. Lightweight. Open source.</div>
    </div>,
    size
  )
}
