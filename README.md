# SunsetGuard

Read-only evidence for finding references to a JavaScript or TypeScript API.

SunsetGuard answers a narrow question: where does a specified package, exact module entry, and named export appear in a known source snapshot? It reports locations, bindings, source identity, and analysis gaps. It does not claim that an API is safe to remove, fully migrated, or executed at runtime.

## Features

- Scan a local source directory or an explicitly pinned public GitHub commit.
- Track ESM named and aliased imports, import-only use, value and type references, static namespace members, direct re-exports, and lexical shadowing.
- Produce JSON, text, or Markdown reports with `detected`, `not-detected-within-scope`, and `unknown` result buckets.
- Preserve partial results and expose unsupported syntax, parse errors, source ambiguity, and resource limits as visible gaps.
- Optionally reuse verified GitHub snapshots and analysis results through a bounded offline cache.

## Quick start

Requires Node.js 24.x and pnpm 11.7.0.

For the independently verified bundle, use the [v0.1.0 release](https://github.com/qweqwe12382/sunsetguard-api-evidence/releases/tag/v0.1.0) and check `SHA256SUMS.txt` before extraction.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build
node dist/cli/bin.js --help
```

Run the complete local verification before submitting a change:

```sh
pnpm run check
```

Run the included offline example:

```sh
node dist/cli/bin.js scan --repos examples/consumers.local.json --package example-lib --symbol oldApi --format markdown
```

Analyze your own source directory:

```sh
node dist/cli/bin.js analyze <source-directory> --package <package-name> --module <exact-module-entry> --symbol <named-export> --format json
```

`--module` defaults to the package name. Use an explicit module entry for a subpath. The source directory is read as data; its dependencies, scripts, tests, and configuration are not executed.

For several consumers, pass a restricted `consumers.json` file to `scan --repos`. Local paths are resolved relative to that manifest. GitHub entries must include an owner, repository, and ref; a full commit SHA is required for offline replay.

## Reading results

`detected` means the scan found countable evidence within the declared scope. `not-detected-within-scope` means the scan completed without finding evidence in that scope. `unknown` means acquisition or analysis left a meaningful gap. Execution status is separate: `complete-within-scope`, `partial`, or `failed`. A partial result can still contain useful findings.

Exit codes are:

| Code | Meaning |
|---:|---|
| `0` | Report generated and all attempted inputs completed within scope |
| `1` | Internal error or output failure |
| `2` | Invalid arguments or manifest |
| `3` | Report generated with a partial or failed input |

JSON mode writes exactly one document to stdout; diagnostics go to stderr. Source snippets are disabled by default. If enabled, only bounded, redacted token context is included.

## Boundaries

The tool never treats a missing reference as proof of migration or safe deletion. It does not execute consumer code, install consumer dependencies, or use a full downstream TypeScript project. CommonJS, dynamic or indirect propagation, ambiguous package resolution, and other target-related unsupported patterns remain visible gaps rather than silent matches.

GitHub access is anonymous by default. A token is read only when the caller explicitly selects `SUNSETGUARD_GITHUB_TOKEN`; it is not taken from Git or `gh` login state. Cache and report paths are checked against source roots, and writes refuse to overwrite existing files.

The package remains private for npm (`private: true`) and has not been published to the registry. The source repository and local trial bundle are licensed under MIT.

## Documentation

- [Implementation specification](docs/SPEC.md) — behavior, result semantics, safety, and limits.
- [Local trial guide](docs/LOCAL_TRIAL.md) — build, examples, cache replay, and independent package checks.
- [Current status](docs/STATUS.md) — completed work and evidence-backed validation.
- [Project report](docs/PROJECT_REPORT.md) — product scope and validation gates.
- [Design decisions](docs/DECISIONS.md) — architecture and security trade-offs.
- [Contributing](CONTRIBUTING.md) — supported scope, development checks, and review expectations.
- [Security policy](SECURITY.md) — reporting process and security-sensitive areas.
- [Maintainers](MAINTAINERS.md) — project ownership and review responsibilities.
- [Changelog](CHANGELOG.md) — user-visible changes by release.
- [Codex for Open Source application packet](docs/CODEX_FOR_OSS_APPLICATION.md) — verified repository fields, copy-ready responses, and applicant-only fields.

## License

[MIT](LICENSE) © 2026 qweqwe12382.

The benchmark labels in `benchmarks/` are provisional and are not a general accuracy claim. Automatic ecosystem discovery, historical comparison, and migration patches are not implemented.
