import { memo, useMemo } from "react";
import { useUpdateSnapshot } from "@/settings/components/UpdateButton";
import { Section, SectionContent, SectionHeader } from "@/settings/layout/PageLayout";
import type { MarkdownBlock } from "@/settings/lib/markdown";
import { parseInlineTokens, parseMarkdownBlocks } from "@/settings/lib/markdown";
import { pickNotesLanguage } from "@/settings/lib/notes";
import type { UpdateState } from "@/settings/types/update";

/**
 * Notes language shown in the About panel. The manifest carries both `zh` and
 * `en`; switch this constant (or wire it to an app-language setting) once the
 * bilingual UI lands.
 */
const NOTES_LANGUAGE = "zh" as const;

/** Once an update body is known, keep it visible through the download flow. */
const NOTE_VISIBLE_STATES = new Set<UpdateState>([
  "available",
  "downloading",
  "downloaded",
  "installing",
]);

function InlineSpans({ text }: { text: string }) {
  return (
    <>
      {parseInlineTokens(text).map((token) => {
        if (token.type === "bold") {
          return (
            <strong key={token.start} className="font-medium text-text">
              {token.text}
            </strong>
          );
        }
        if (token.type === "code") {
          return (
            <code
              key={token.start}
              className="rounded border border-border px-1 py-px font-mono text-[11px]"
            >
              {token.text}
            </code>
          );
        }
        return <span key={token.start}>{token.text}</span>;
      })}
    </>
  );
}

// Blocks come from a memoized parse, so identical props let React skip
// re-rendering every block while download-progress events fire.
const Block = memo(function Block({ block }: { block: MarkdownBlock }) {
  if (block.type === "heading") {
    return <h3 className="text-xs font-semibold text-text">{block.text}</h3>;
  }
  if (block.type === "paragraph") {
    return (
      <p className="text-xs leading-relaxed text-text-muted">
        <InlineSpans text={block.text} />
      </p>
    );
  }
  return (
    <ul className="space-y-1.5">
      {block.items.map((item) => (
        <li key={item.line} className="flex gap-2 text-xs leading-relaxed text-text-muted">
          <span
            aria-hidden="true"
            className="mt-[7px] size-1 shrink-0 rounded-full bg-text-muted/60"
          />
          <span className="min-w-0">
            <InlineSpans text={item.text} />
          </span>
        </li>
      ))}
    </ul>
  );
});

/**
 * Release notes for the pending update, shown on the About page only while a
 * newer version is available (or being downloaded). Hidden entirely when the
 * app is up to date or the manifest carries no notes. The section grows to
 * its full height — the settings page itself scrolls.
 */
export function ReleaseNotes() {
  const current = useUpdateSnapshot();
  // current.notes keeps a stable reference between snapshots, so the parse
  // (and every Block) is skipped while unrelated snapshot fields change.
  const blocks = useMemo(
    () => parseMarkdownBlocks(pickNotesLanguage(current.notes, NOTES_LANGUAGE).trim()),
    [current.notes],
  );

  if (!NOTE_VISIBLE_STATES.has(current.state) || blocks.length === 0) return null;

  return (
    <Section>
      <SectionHeader title={current.version ? `v${current.version} 更新内容` : "更新内容"} />
      <SectionContent>
        <div className="space-y-3">
          {blocks.map((block) => (
            <Block key={block.line} block={block} />
          ))}
        </div>
      </SectionContent>
    </Section>
  );
}
