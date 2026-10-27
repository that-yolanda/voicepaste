# Repository Guidelines

## Project Structure

This directory contains VoicePaste’s independent Next.js website. Keep its dependencies and lockfile separate from the Tauri app.

- `app/[lang]/`: localized home, downloads, and documentation routes; `app/api/search/` provides document search.
- `components/`: marketing and interactive components; `components/ui/` contains shadcn controls.
- `content/docs/`: English `.mdx` files, Chinese `.zh.mdx` counterparts, and navigation metadata.
- `lib/`, `config/releases.json`: shared logic, bilingual copy, SEO, and installer URLs.
- `public/assets/`, `tests/`: media and Node test files.

## Development & Validation

Run inside `website/`:

```bash
pnpm install --frozen-lockfile
pnpm dev        # Local server on port 3000
pnpm lint       # ESLint
pnpm typecheck  # TypeScript
pnpm test       # Node tests through tsx
pnpm build      # Production build
pnpm start      # Serve the production build
```

`pnpm format` rewrites TypeScript using Prettier and Tailwind class sorting. Use two spaces, double quotes, no semicolons, and 80-column lines. Follow existing kebab-case filenames, PascalCase components, and camelCase functions.

## Product & Architecture Rules

Preserve the shadcn theme, brand-only Sora, and default dark mode. Run component-generation commands here. Prefer server components; isolate interactive demos behind client boundaries. Keep meaningful copy and download links readable without JavaScript.

Maintain `/en` and `/zh`, canonical/hreflang metadata, and manual language preference. Detection applies only to unprefixed entry URLs. Update both languages together. Keep downloads sourced from `config/releases.json`.

Pause offscreen animations, honor reduced motion, and require explicit opt-in for sound. Feedback delivery uses server-side Resend REST calls; keep credentials and the fixed recipient server-only. Configure feedback rate limiting in Vercel, not with an in-memory counter.

## Tests & Contributions

Name tests `tests/*.test.ts`; cover changed logic and regressions. No numeric coverage threshold is configured. For UI changes, check both languages, themes, mobile layout, and keyboard interaction. Include screenshots and validation results in PRs.

Use English Conventional Commits, such as `fix(website): preserve download language`. Never commit secrets, `.next/`, `.source/`, or `node_modules/`. Configure the deployment domain through `NEXT_PUBLIC_SITE_URL`. Follow root guidelines for safe deletion and publication authorization.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
