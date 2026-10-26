import { PlatformIcon } from "./platform-icon"
import { buttonVariants } from "@/components/ui/button"
import {
  latest,
  asset,
  platformNames,
  type Platform,
  type Release,
} from "@/lib/releases"
import { cn } from "@/lib/utils"
export function DownloadButton({
  platform,
  secondary = false,
  release = latest,
  label,
  showSize = false,
}: {
  platform: Platform
  secondary?: boolean
  release?: Release
  label?: string
  showSize?: boolean
}) {
  const file = asset(release, platform)
  return (
    <a
      data-download={platform}
      href={file.url}
      aria-label={
        label
          ? `${platformNames[platform]} · ${release.version} · ${label}${showSize ? ` · ${(file.size / 1e6).toFixed(1)} MB` : ""}`
          : undefined
      }
      className={cn(
        buttonVariants({
          variant: secondary ? "secondary" : "default",
          size: "lg",
        }),
        "min-h-12 gap-2 px-5",
        showSize && "h-16 min-w-44 py-3"
      )}
    >
      {!showSize && <PlatformIcon platform={platform} />}
      {showSize ? (
        <span className="flex flex-col gap-1 text-center">
          <span>{label ?? platformNames[platform]}</span>
          <span className="text-xs font-normal opacity-80">
            {(file.size / 1e6).toFixed(1)} MB
          </span>
        </span>
      ) : (
        (label ?? platformNames[platform])
      )}
    </a>
  )
}
