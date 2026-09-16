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
- Release evidence: `https://github.com/qweqwe12382/sunsetguard-api-evidence/releases/tag/v0.1.0`

## Copy-ready form responses

### Why does this repository qualify?

> SunsetGuard is an early-stage MIT-licensed TypeScript CLI for evidence-backed API deprecation audits. It scans explicit local or pinned public source snapshots without executing consumer code, separates value, type, import-only, and re-export evidence, and keeps unsupported or partial analysis visible. This addresses a recurring JS/TS maintenance problem: finding downstream references without turning non-detection into a safe-removal claim. Linux and Windows CI cover 528 offline tests.

The response stays within the form's 500-character limit. It relies on ecosystem importance and current engineering evidence; it does not claim broad adoption, downloads, or a general accuracy rate.

### How will you use API credits for your project?

> We will use API credits only for maintaining SunsetGuard: triaging public issues, reviewing pull requests against source-isolation and result-safety rules, proposing bounded synthetic regression fixtures, summarizing CI failures, and drafting release notes. Human review remains required. We will not send private downstream source, secrets, local paths, or user reports to the API, and will not use program benefits to review code we do not own or lack permission to review.

This plan limits program-funded model use to the SunsetGuard repository and authorized maintainer workflows. SunsetGuard's normal static analysis remains local and deterministic.

### Anything else we should know?

> SunsetGuard is intentionally conservative: not-detected never means migrated or safe to remove, and partial/unknown states remain visible. The repository ships MIT-licensed source and a checksum-verified local trial bundle, with contribution, security, maintainer, and release documentation. Current benchmark labels are provisional and third-party adoption is not yet verified; program support would be used to obtain real maintainer feedback and independently reviewed evidence.

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
