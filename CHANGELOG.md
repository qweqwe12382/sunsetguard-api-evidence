# Changelog

SunsetGuard is not yet published as a package. This file records user-visible repository changes; detailed validation evidence remains in `docs/STATUS.md`.

## Unreleased

### Added

- Linux and Windows CI for locked installation, type checking, linting, building, and offline tests.
- Contribution guidance, a security reporting policy, and structured issue templates.

### Fixed

- Newly generated attribution reports no longer export downstream dependency declaration values; legacy analysis-cache records containing them are rejected and recomputed from a verified snapshot. Historical benchmark artifacts remain unchanged as versioned evidence of earlier runs.
- Failed report publication cleans up its own linked output when file and parent identities remain trustworthy.
- Missing CLI options identify the actual option, and unsafe initial cache placement exits as invalid configuration.
- Local snapshot limit overrides can only lower the built-in resource ceilings.

### Changed

- The specification now describes create-if-absent report publication instead of replacement semantics.
- Repository metadata and a single `pnpm run check` verification entry point were added.
