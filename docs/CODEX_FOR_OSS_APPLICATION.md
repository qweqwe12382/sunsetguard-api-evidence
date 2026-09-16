# Codex for Open Source application packet

Last verified: 2026-09-16.

This packet maps SunsetGuard's current, verifiable repository state to the official [Codex for Open Source application](https://openai.com/form/codex-for-oss/) and [program terms](https://developers.openai.com/codex/codex-for-oss-terms). It does not estimate acceptance probability or replace the applicant's review of the current terms.

## Applicant-supplied fields

Fill these directly in the official form. Do not commit them to this repository.

- First name: `[REQUIRED — applicant enters]`
- Last name: `[REQUIRED — applicant enters]`
- Email associated with the applicant's ChatGPT account: `[REQUIRED — applicant enters]`
- OpenAI Organization ID: `[REQUIRED — applicant enters]`
- Confirm the GitHub profile is public before submission.

## Verified repository fields

- GitHub username: `qweqwe12382`
- Repository: `https://github.com/qweqwe12382/sunsetguard-api-evidence`
- Role: **Primary maintainer**
- Interests: **API credits for my project** and **Codex Security**
- License: MIT
- Maintainer evidence: repository ownership, `MAINTAINERS.md`, `.github/CODEOWNERS`, contribution and security policies, tagged release, and Linux/Windows CI.
- Release evidence: `https://github.com/qweqwe12382/sunsetguard-api-evidence/releases/tag/v0.1.1`

## Copy-ready form responses

### Why does this repository qualify?

> SunsetGuard is an early-stage MIT-licensed TypeScript CLI for evidence-backed API deprecation audits. It scans explicit local or pinned public source snapshots without executing consumer code, separates value, type, import-only, and re-export evidence, and keeps unsupported or partial analysis visible. This addresses a recurring JS/TS maintenance problem: finding downstream references without turning non-detection into a safe-removal claim. Linux and Windows CI cover 528 offline tests.

The response stays within the form's 500-character limit. It relies on ecosystem importance and current engineering evidence; it does not claim broad adoption, downloads, or a general accuracy rate.

### How will you use API credits for your project?

> Codex has already been part of SunsetGuard’s maintenance workflow: reviewing threat boundaries, turning product invariants into regression tests, investigating cross-platform failures, auditing release hygiene, and drafting maintainer documentation. API credits would extend this to issue triage, PR review, bounded synthetic fixtures, CI failure analysis, and release notes. Human review stays mandatory, and we will not send private downstream source, secrets, local paths, or unauthorized code.

This plan limits program-funded model use to the SunsetGuard repository and authorized maintainer workflows. SunsetGuard's normal static analysis remains local and deterministic.

### Why does your project need Codex Security?

> SunsetGuard reads untrusted repositories under strict isolation and produces evidence for API deprecation decisions. Codex Security would help review root confinement, symlink handling, archive extraction, compiler-host boundaries, cache identity, JSON output isolation, and secret/path redaction; add regression tests; and triage disclosures. We would use it only on SunsetGuard and code we are authorized to review, with maintainer verification before fixes or releases.

This field appears after selecting **Codex Security** and stays within the form's 500-character limit.

### Anything else we should know?

> OpenAI models have been especially useful in developing SunsetGuard because it combines compiler analysis, security boundaries, cross-platform behavior, and user-facing claims. Codex helped inspect implementation against the specification, identify gaps, strengthen tests, verify Linux/Windows release results, and clean public release content. This produced a more reviewable OSS project, while deterministic analysis and human approval remain the final authority.

The response describes observed use during development without replacing deterministic analysis or human approval. The repository's early-stage adoption limits remain stated in the qualification response and evidence sections below.

## Evidence links

- Project overview and usage: `README.md`
- Maintainer role: `MAINTAINERS.md` and `.github/CODEOWNERS`
- Contribution workflow: `CONTRIBUTING.md`
- Security process: `SECURITY.md`
- Release history: `CHANGELOG.md` and the GitHub Releases page
- Validation record: `docs/STATUS.md`
- Product and safety contract: `docs/SPEC.md`
- Benchmark limits: `benchmarks/README.md`

## Submission checklist

- [ ] Enter the applicant's real name, ChatGPT-account email, and OpenAI Organization ID.
- [ ] Confirm the GitHub profile and repository are public.
- [ ] Recheck the official form and program terms immediately before submitting.
- [ ] Confirm every response is still accurate after the latest release.
- [ ] Do not add confidential information; the program terms state that application material is not confidential.
- [ ] Submit through the official form. Repository preparation does not submit an application automatically.

## Claims that remain unavailable

Do not claim verified external adoption, monthly downloads, independent general accuracy, production SLA, macOS validation, or permission to scan arbitrary third-party code with program benefits. These require separate evidence or authorization.
