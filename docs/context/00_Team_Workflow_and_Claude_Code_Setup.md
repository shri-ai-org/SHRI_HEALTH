# Shri Health OpenEMR Edition — Team Workflow and Claude Code Setup

Read this first. It sets up one repository where Vimal, Thulasi, Anand and Minalini each work in their own folders, with Claude Code, without overwriting each other. Each person's own steps are in their guide (`01_` to `04_`).

## 1. The short version

- **One GitHub repository (monorepo)** holds everything: API contracts, backend, AI, frontend, infrastructure.
- **Every folder has one owner.** GitHub enforces this with `CODEOWNERS`: nobody can merge a change to your folder without your approval.
- **Contracts first.** Every endpoint is defined in the OpenAPI file before anyone builds it. Screens use a client generated from that file, so a breaking API change fails the build instead of failing silently.
- **Small changes, merged every day.** Long-lived branches are where teams drift apart.
- **Everyone sees changes as they happen** through GitHub notifications in Slack and a staging server that redeploys on every merge.
- **Claude Code runs on each person's machine, on their own branch.** It is told (CLAUDE.md) and blocked (permission rules) from editing other people's folders.

Git alone is not enough. Git stores the code; the rules below stop people from stepping on each other.

## 2. Repository layout and owners

```
shri-health/
├── CLAUDE.md                          # shared rules for everyone and every Claude session
├── .claude/settings.json              # shared Claude Code permissions            — Thulasi
├── .github/CODEOWNERS, workflows/     # ownership and CI                          — Thulasi
├── contracts/openapi/                 # THE API contract (single source of truth) — Vimal
├── backend/app/
│   ├── core/                          # auth, permissions, tenancy, audit, crypto, errors, events — Thulasi
│   ├── integration/                   # integration engine, webhooks, partner transports          — Thulasi
│   ├── db/                            # SQLAlchemy models + Alembic migrations                     — Anand
│   ├── fhir/                          # HAPI FHIR client and mappings                              — Anand
│   └── modules/
│       ├── patients/ scheduling/ eligibility/ encounters/ history/ ai/                         — Vimal
│       ├── medications/ orders/                                                                — Thulasi
│       ├── practice_setup/ billing/ documents/ files/ ccda/ inbox/ exports/ onboarding/        — Anand
│       └── communications/ dashboards/                                                         — Minalini
├── ai/                                # AI gateway, model serving, speech, RAG, evaluation         — Vimal
├── frontend/
│   ├── src/design-system/ src/app/                                                             — Minalini
│   ├── src/features/{patients,scheduling,clinical,medications,orders,inbox,portal}/            — Minalini
│   ├── src/features/ai/                                                                        — Vimal
│   ├── src/features/{admin-setup,billing,documents}/                                           — Anand
│   └── src/api/generated/             # generated from the contract — nobody edits by hand
├── infra/
│   ├── compose/ nginx/ keycloak/ terraform/                                                    — Thulasi
│   └── hapi/ postgres/ seaweedfs/                                                              — Anand
└── docs/adr/                          # architecture decisions                                     — everyone
```

Tests live inside each module folder (`backend/app/modules/<module>/tests/`), so tests belong to the module's owner.

## 3. GitHub setup (Thulasi does this on Day 1)

### CODEOWNERS

Save as `.github/CODEOWNERS`. Replace `@vimal`, `@thulasi`, `@anand`, `@minalini` with real GitHub usernames.

```
# Default: Thulasi reviews anything not listed below
*                                         @thulasi

/CLAUDE.md                                @vimal @thulasi @anand @minalini
/contracts/                               @vimal
/backend/app/core/                        @thulasi
/backend/app/integration/                 @thulasi
/backend/app/db/                          @anand
/backend/app/fhir/                        @anand
/backend/app/modules/patients/            @vimal
/backend/app/modules/scheduling/          @vimal
/backend/app/modules/eligibility/         @vimal
/backend/app/modules/encounters/          @vimal
/backend/app/modules/history/             @vimal
/backend/app/modules/ai/                  @vimal
/backend/app/modules/medications/         @thulasi
/backend/app/modules/orders/              @thulasi
/backend/app/modules/practice_setup/      @anand
/backend/app/modules/billing/             @anand
/backend/app/modules/documents/           @anand
/backend/app/modules/files/               @anand
/backend/app/modules/ccda/                @anand
/backend/app/modules/inbox/               @anand
/backend/app/modules/exports/             @anand
/backend/app/modules/onboarding/          @anand
/backend/app/modules/communications/      @minalini
/backend/app/modules/dashboards/          @minalini
/ai/                                      @vimal
/frontend/                                @minalini
/frontend/src/features/ai/                @vimal @minalini
/frontend/src/features/admin-setup/       @anand @minalini
/frontend/src/features/billing/           @anand @minalini
/frontend/src/features/documents/         @anand @minalini
/infra/hapi/                              @anand
/infra/postgres/                          @anand
/infra/seaweedfs/                         @anand
```

### Branch protection on `main`

- Pull request required; no direct pushes.
- Review from code owners required.
- All CI checks must pass.
- Branch must be up to date with `main` before merging.

### Branch and pull request rules

- Branch names: `<name>/<short-task>`, for example `vimal/patient-search`, `anand/hapi-setup`.
- Keep pull requests small (aim for under ~400 changed lines) and merge at least once a day.
- Rebase on `main` every morning: `git pull --rebase origin main`.
- Unfinished features hide behind a feature flag instead of waiting on a long branch.

## 4. CI checks (run on every pull request)

| Check | Tool | Catches |
|---|---|---|
| Python lint, types, tests | ruff, mypy, pytest | Broken backend code |
| Frontend lint, types, tests | eslint, tsc, vitest | Broken screens |
| Contract lint | Spectral | Badly written endpoints |
| Breaking API change | oasdiff (compares against `main`) | A change that would break someone else's code |
| Generated client up to date | regenerate and `git diff --exit-code` | Screens using a stale API |
| Implementation matches contract | Schemathesis against the running API | Endpoint returning something different from the contract |
| Database drift | `alembic check` | Models and migrations out of step |
| FHIR conformance | HL7 FHIR Validator with US Core | Bad FHIR resources sent to HAPI |
| Secrets | gitleaks | Keys or passwords committed by mistake |

## 5. How a change to an API flows between people

1. Someone needs a new or changed endpoint → they open a pull request to `contracts/openapi/` → Vimal reviews.
2. On merge, CI regenerates the TypeScript client and the mock server.
3. The backend owner of that module implements it; Schemathesis checks it matches the contract.
4. Minalini (or the screen owner) uses the generated client. If the contract changed in a breaking way, the frontend build fails and shows exactly where.

Nobody changes an endpoint's shape without a contract pull request first.

## 6. Keeping everyone up to date

| Need | Use |
|---|---|
| See every PR, merge, CI failure and deploy as it happens | GitHub app in a Slack channel (e.g. `#shri-dev`). WhatsApp only for quick chat, never patient data |
| Track tasks and handoffs | GitHub Projects board: Backlog → In progress → Blocked → Review → Done. Each handoff is an issue with a "blocked by" link, so a blocked person can see who they're waiting on |
| Try each other's work | Staging server redeploys `main` automatically; one `docker compose up` runs everything locally |
| Shared context for Claude chats | The Claude Team project holding FRS v1.2, Technical Architecture v1.1, the implementation plan, the task plan and the schema README, so everyone's Claude chats answer from the same documents |
| Daily sync | 15 minutes, or a written update in Slack: done, doing, blocked |
| Decisions | A short ADR in `docs/adr/` for anything that affects more than one person |

## 7. Claude Code setup

Claude Code runs locally for each person on their own branch. It is not live co-editing; GitHub is where everyone's work meets. Two layers keep each person's Claude inside their own area.

### Layer 1: instructions (CLAUDE.md)

Root `CLAUDE.md`, committed, read by every session:

```markdown
# Shri Health — rules for every Claude Code session

## Ownership
Edit only the folders owned by the person running this session (see .github/CODEOWNERS).
If a change is needed in someone else's folder, stop and write a short note describing it
for that owner instead of editing it.

## Architecture rules
- Clinical data lives in HAPI FHIR; administrative data in our PostgreSQL.
- Reach HAPI only through backend/app/fhir/ (its FHIR API). Never query or modify HAPI's tables.
- Security lives in backend/app/core/. Endpoints never handle tokens, passwords or encryption themselves.
- Every endpoint uses: Depends(require("<permission>")) and Depends(tenant_db).
- Endpoints must match contracts/openapi/. Change the contract first.
- No DELETE on clinical records; use entered-in-error.
- Database changes only through Alembic migrations in backend/app/db/.

## Code conventions
- Module layout: api.py (routes, thin) → service.py (rules) → repository.py (data) → schemas.py (Pydantic).
- Errors: raise the classes in backend/app/core/errors.py; never return ad-hoc error dicts.
- Tests: pytest in the module's tests/ folder; every endpoint gets at least one success and one permission-denied test.
- Never put patient data in logs, test fixtures or prompts. Synthetic data only.
- Never edit frontend/src/api/generated/ by hand.
```

Each owner adds a short `CLAUDE.md` inside their own folders with local conventions (for example `backend/app/fhir/CLAUDE.md` explains how to call the FHIR client). Claude loads the root file plus the folder file for the area it is working in.

### Layer 2: hard blocks (permission rules)

Shared `.claude/settings.json`, committed, applies to everyone:

```json
{
  "permissions": {
    "deny": [
      "Read(.env)",
      "Read(.env.*)",
      "Edit(.env)",
      "Edit(.env.*)",
      "Edit(frontend/src/api/generated/**)"
    ]
  }
}
```

Personal `.claude/settings.local.json`, not committed (git ignores it), one per person. It blocks Claude from editing everyone else's folders. Example for Vimal:

```json
{
  "permissions": {
    "deny": [
      "Edit(backend/app/core/**)",
      "Edit(backend/app/integration/**)",
      "Edit(backend/app/db/**)",
      "Edit(backend/app/fhir/**)",
      "Edit(backend/app/modules/medications/**)",
      "Edit(backend/app/modules/orders/**)",
      "Edit(backend/app/modules/practice_setup/**)",
      "Edit(backend/app/modules/billing/**)",
      "Edit(backend/app/modules/documents/**)",
      "Edit(backend/app/modules/files/**)",
      "Edit(backend/app/modules/ccda/**)",
      "Edit(backend/app/modules/inbox/**)",
      "Edit(backend/app/modules/exports/**)",
      "Edit(backend/app/modules/onboarding/**)",
      "Edit(backend/app/modules/communications/**)",
      "Edit(backend/app/modules/dashboards/**)",
      "Edit(infra/**)",
      "Edit(.github/**)"
    ]
  }
}
```

Each person's guide has their own version of this file. Always start Claude Code from the repository root so these paths resolve, then run `/permissions` once to confirm the rules are active.

These rules stop Claude's own file-editing tools; they do not stop a shell command Claude runs. That is why CODEOWNERS and branch protection stay the real guard: even if something slips through locally, it cannot reach `main` without the owner's approval.

### Working on two tasks at once

Use git worktrees to run two Claude sessions on two branches without them colliding:

```bash
git worktree add ../shri-health-billing anand/billing
cd ../shri-health-billing && claude
```

## 8. Definition of done for every pull request

- [ ] Contract exists (or was updated first) for every endpoint touched
- [ ] Uses `require()` and `tenant_db`; no security code inside the endpoint
- [ ] Tests: success, permission denied, validation error
- [ ] CI green, including contract and breaking-change checks
- [ ] No patient data in code, logs, fixtures or prompts
- [ ] Code owner approved
- [ ] Demoed on staging at the weekly review
