# Contributing to Nudge

Thanks for helping! Nudge is small on purpose, so contributions are easiest to review when they stay focused.

## Getting started

```bash
npm install
npx wrangler login   # Workers AI runs remotely, even in local dev
npm run dev          # or: npm run dev:offline (no login, no LLM)
```

## Before opening a PR

```bash
npm run check        # format check + lint + typecheck + unit tests
```

If you touched scheduling, the agent, or the database, also run the end-to-end smoke test against a dev server:

```bash
npm run dev:offline  # terminal 1
npm run smoke        # terminal 2
```

## Guidelines

- **Keep rules pure.** Anything with logic (state transitions, time math, backoff, learning, prompts) belongs in `src/lib/` with no Cloudflare imports, and needs a test in `test/`.
- **Verify SDK APIs against the installed types** in `node_modules/agents` and `node_modules/@cloudflare/ai-chat`; they change between releases.
- **Errors are values.** Tools and RPC methods return `{ ok: false, error }` with a message a person (or the model) can act on; don't throw across those boundaries.
- **Schema changes** go in a new entry at the end of `MIGRATIONS` in `src/db.ts`. Never edit an existing migration.
- Use conventional commit messages (`feat:`, `fix:`, `docs:`, `chore:`).

## Reporting bugs

Open an issue with steps to reproduce, what you expected, and what happened. Include your timezone if it involves reminder times.
