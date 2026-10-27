/**
 * Minimal Markdown parser for release notes.
 *
 * Supports only the constructs that appear in CHANGELOG.zh.md sections:
 * `#`-prefixed headings, `-` list items, `**bold**` and `` `code` `` inline
 * spans. Everything else renders as plain text — note strings come from a
 * remote manifest, so unknown syntax must degrade safely instead of being
 * injected as HTML.
 *
 * Tokens and blocks carry their source position (line / offset), which is
 * unique within one parse and therefore serves as a stable React key.
 */

export interface InlineToken {
  type: "text" | "bold" | "code";
  text: string;
  /** 0-based character offset of `text` within its source line. */
  start: number;
}

export interface ListItem {
  text: string;
  /** 1-based line number of the item in the source document. */
  line: number;
}

export type MarkdownBlock =
  | { type: "heading"; text: string; line: number }
  | { type: "paragraph"; text: string; line: number }
  | { type: "list"; items: ListItem[]; line: number };

const INLINE_SPAN = /(\*\*[^*]+\*\*|`[^`]+`)/g;
const HEADING = /^#{1,6}\s+(.*)$/;
const LIST_ITEM = /^[-*]\s+(.*)$/;

/** Split one line of text into bold / code / plain-text tokens. */
export function parseInlineTokens(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let cursor = 0;

  for (const match of text.matchAll(INLINE_SPAN)) {
    const span = match[0];
    const spanStart = match.index ?? 0;
    if (spanStart > cursor) {
      tokens.push({ type: "text", text: text.slice(cursor, spanStart), start: cursor });
    }

    if (span.startsWith("**")) {
      tokens.push({ type: "bold", text: span.slice(2, -2), start: spanStart + 2 });
    } else {
      tokens.push({ type: "code", text: span.slice(1, -1), start: spanStart + 1 });
    }
    cursor = spanStart + span.length;
  }

  if (cursor < text.length) {
    tokens.push({ type: "text", text: text.slice(cursor), start: cursor });
  }
  return tokens;
}

/** Parse a Markdown document into heading / paragraph / list blocks. */
export function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = markdown.split(/\r?\n/);

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (line === "") continue;
    const lineNumber = index + 1;

    const heading = line.match(HEADING);
    if (heading) {
      blocks.push({ type: "heading", text: heading[1].trim(), line: lineNumber });
      continue;
    }

    const item = line.match(LIST_ITEM);
    if (item) {
      const last = blocks[blocks.length - 1];
      if (last?.type === "list") {
        last.items.push({ text: item[1].trim(), line: lineNumber });
      } else {
        blocks.push({
          type: "list",
          items: [{ text: item[1].trim(), line: lineNumber }],
          line: lineNumber,
        });
      }
      continue;
    }

    blocks.push({ type: "paragraph", text: line, line: lineNumber });
  }

  return blocks;
}
