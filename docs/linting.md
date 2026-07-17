# Linting and formatting

## ESLint (enforced)

`npm run lint` runs ESLint (flat config in `eslint.config.mjs`) across the
server, web, shared contracts, and tooling scripts. It is a required CI step in
the `quality` job, so lint failures block merges.

- **Server + contracts** are linted with `typescript-eslint`'s
  `recommendedTypeChecked` set. The rules this adoption exists for are the
  async-safety ones — `no-floating-promises`, `no-misused-promises`,
  `await-thenable` — which TypeScript's `strict` mode cannot catch.
- **Web** (`.ts` + `.vue`) uses `eslint-plugin-vue`'s recommended set with a
  syntactic TypeScript parser; `vue-tsc` already provides the type checking.
- A few type-aware rules that fire on intentional, safe patterns are disabled
  with an explanatory comment in the config: `no-base-to-string` and
  `restrict-template-expressions` (explicit `String(...)` over `unknown` DB
  rows) and `require-await` (functions kept async to satisfy a shared
  signature). Test files relax the async rules because the `node:test` runner
  intentionally does not await top-level `test(...)` calls.

Run `npm run lint:fix` to apply autofixes.

## Prettier (opt-in, staged rollout)

Prettier is configured (`.prettierrc.json`) to match the existing style, and
`eslint-config-prettier` keeps ESLint from fighting it. Two scripts are
available:

- `npm run format` — write formatting across the repo.
- `npm run format:check` — report files that are not formatted.

**CI does not yet gate on `format:check`.** The existing code predates Prettier,
so a repository-wide reformat touches most files at once. To keep this change
reviewable and avoid conflicting with the in-flight dependency and feature PRs,
the bulk reformat is deliberately deferred to its own dedicated PR; once that
lands, `format:check` should be added to the `quality` job.
