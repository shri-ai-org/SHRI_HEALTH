# ADR 0001 — Repository ownership and workflow

- **Status:** Accepted
- **Date:** 2026-10-22
- **Deciders:** Vimal, Thulasi, Anand, Minalini

## Context

Four people (and their Claude Code sessions) build Shri Health in parallel: API contracts, backend, AI, frontend and infrastructure. Without clear ownership and a single path to `main`, people overwrite each other's work and the API drifts between backend and screens.

## Decision

1. **Monorepo.** One repository (`shri-ai-org/SHRI_HEALTH`) holds contracts, backend, AI, frontend, infrastructure and docs, laid out as in `docs/context/00_Team_Workflow_and_Claude_Code_Setup.md` §2.
2. **CODEOWNERS ownership.** Every folder has one owner, recorded in `.github/CODEOWNERS`. A change to a folder needs its owner's review. The root `CLAUDE.md` is co-owned by all four.
3. **Branch naming `<name>/<task>`**, for example `vimal/patient-search`, `anand/hapi-setup`.
4. **Pull requests only to `main`.** No direct pushes, no force pushes. Small PRs, merged daily; rebase on `main` every morning.
5. **Contracts first.** Every endpoint is defined in `contracts/openapi/` before it is built; screens use the client generated from it in `frontend/src/api/generated/`, which nobody edits by hand.
6. **Claude Code guardrails.** The shared `CLAUDE.md` and `.claude/settings.json` apply to everyone; each person keeps a personal, git-ignored `.claude/settings.local.json` that blocks edits outside their folders.

## Consequences

- Cross-folder changes need a note to, or a PR reviewed by, the owner — slower for one person, safer for the team.
- API changes start with a contract PR reviewed by Vimal.
- Enforcing "PR only" and "code-owner review required" on `main` needs branch protection, which GitHub's Free plan does not offer for private repositories; until the org upgrades (or protection is otherwise available), these rules are kept by agreement.
