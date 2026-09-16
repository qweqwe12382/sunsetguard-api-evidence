# Security policy

## Supported code

The current `main` branch is the only maintained code line. SunsetGuard has no published package release or production service.

## Reporting a vulnerability

GitHub private vulnerability reporting is not currently enabled for this repository. Open the [Security contact request](https://github.com/qweqwe12382/sunsetguard-api-evidence/issues/new?template=security_contact.yml) form to ask the maintainer for a private contact channel without including exploit details, secrets, private source, or local paths. If the repository later exposes **Security → Report a vulnerability**, use that private form instead.

After a private channel is established, include the affected commit, operating system, Node.js version, a minimal reproduction using synthetic data, expected behavior, and observed impact. Relevant areas include source-root escape, symlink or hard-link races, consumer code execution, credential or path disclosure, cache confusion, report overwrite, and a clean or complete conclusion produced from incomplete analysis.

Do not test against repositories or systems you do not control. Public issues are appropriate for ordinary correctness bugs that do not expose sensitive information.
