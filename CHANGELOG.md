# Changelog

SunsetGuard is not yet published as a package. This file records user-visible repository changes; detailed validation evidence remains in `docs/STATUS.md`.

## Unreleased

## [0.1.1] - 2026-09-16

### Changed

- Replaced internal development diaries with concise public status, roadmap, and current design-decision documents.
- Removed local workspace identifiers and repository-internal process notes from public benchmark and product documentation.
- Kept application, validation, safety, and known-limit evidence while making the current repository tree suitable for external review.

## [0.1.0] - 2026-09-16

### Added

- Linux and Windows CI for locked installation, type checking, linting, building, and offline tests.
- Contribution guidance, a security reporting policy, and structured issue templates.
- MIT licensing in the repository and local trial bundle.
- Maintainer ownership, CODEOWNERS, release notes, and a truth-bounded Codex for Open Source application packet.

### Fixed

- Newly generated attribution reports no longer export downstream dependency declaration values; legacy analysis-cache records containing them are rejected and recomputed from a verified snapshot. Historical benchmark artifacts remain unchanged as versioned evidence of earlier runs.
- Failed report publication cleans up its own linked output when file and parent identities remain trustworthy.
- Missing CLI options identify the actual option, and unsafe initial cache placement exits as invalid configuration.
- Local snapshot limit overrides can only lower the built-in resource ceilings.
- Local snapshot traversal sorts each fully enumerated directory before applying file and byte limits, so bounded results do not depend on operating-system directory order.

### Changed

- The specification now describes create-if-absent report publication instead of replacement semantics.
- Repository metadata and a single `pnpm run check` verification entry point were added.
