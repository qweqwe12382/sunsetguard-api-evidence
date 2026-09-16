# Contributing to SunsetGuard

SunsetGuard is a deliberately narrow, read-only evidence tool. Contributions should preserve the distinction between observed evidence and claims about migration, runtime use, or safe deletion.

## Development setup

Use Node.js 24.x and pnpm 11.7.0. Install only this repository's locked dependencies; lifecycle scripts remain disabled by project policy.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run check
```

The complete check runs strict TypeScript validation, ESLint, a production build, and the offline Vitest suite. Tests treat consumer fixtures as data and must never execute consumer source, configuration, tests, plugins, or package scripts.

## Change expectations

- Keep changes within the scope documented in `docs/SPEC.md` and record behavior changes in `CHANGELOG.md`.
- Add positive, negative, lexical-shadowing, and unsupported-pattern coverage when extending analysis rules.
- Preserve visible `unknown`, `partial`, and gap states. A missing match cannot become a safety or migration claim.
- Do not include downstream source, secrets, local absolute paths, generated reports, caches, or dependency directories in a commit.
- State which checks actually ran. A skipped or unrun check is not a pass.

Open an issue before a large feature or scope expansion. Small fixes with focused tests can go directly to a pull request. This repository currently has no declared software license; the project owner must resolve licensing separately before broader redistribution or package publication.
