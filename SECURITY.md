# Security policy

## Supported versions

| Version | Supported |
|---|---|
| `0.1.x` | Yes |
| `< 0.1` | No |

The current `main` branch is maintained alongside the latest `0.1.x` GitHub release. SunsetGuard has no npm package or production service.

## Reporting a vulnerability

Use GitHub's private **Security → Report a vulnerability** form for security-sensitive reports. If that interface is temporarily unavailable, open the [Security contact request](https://github.com/qweqwe12382/sunsetguard-api-evidence/issues/new?template=security_contact.yml) form only to ask the maintainer for a private contact channel; do not include exploit details, secrets, private source, or local paths in the public issue.

After a private channel is established, include the affected commit, operating system, Node.js version, a minimal reproduction using synthetic data, expected behavior, and observed impact. Relevant areas include source-root escape, symlink or hard-link races, consumer code execution, credential or path disclosure, cache confusion, report overwrite, and a clean or complete conclusion produced from incomplete analysis.

Do not test against repositories or systems you do not control. Public issues are appropriate for ordinary correctness bugs that do not expose sensitive information.
