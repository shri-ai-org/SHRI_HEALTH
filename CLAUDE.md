# Shri Health — rules for every Claude Code session

@docs/context/DECISIONS.md

## Ownership
Edit only the folders owned by the person running this session (see .github/CODEOWNERS).
If a change is needed in someone else's folder, stop and write a short note describing it
for that owner instead of editing it.

## Architecture rules
- One PostgreSQL database: clinical tables are FHIR-shaped, admin tables are normalized (ADR-0011). There is no HAPI.
- Writes that belong together happen in one transaction.
- Data access goes through each module's repository, using Anand's helpers in backend/app/db/.
- No database role or query may bypass row-level security.
- Outside systems use the read-only /fhir API (backend/app/fhir/); our screens use /api/v1 only.
- The outbox is for external partners only (labs, e-prescribing, clearinghouse, fax, SMS).
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
- Never run npx, npm install, pip install, uv pip install or uvx for a package that is not already in a project lockfile. New dependencies are added only through a pull request that changes the lockfile, follows the 7-day rule, and is reviewed by that folder's owner; Python dependencies go through pyproject.toml plus regenerated hashed locks (backend/README.md).
- Only add dependencies and tools under an allowed licence (DECISIONS.md D75); anything else needs a recorded exception first.

## GitHub Actions minutes
Actions minutes are limited (D74 amendment, D106):
- run lint, the type check, the tests and gitleaks locally before every push;
- batch pushes, one per review round;
- keep PRs as drafts until ready, since drafts don't run CI;
- re-run only a failed job, after fixing its cause;
- don't close and reopen PRs to trigger CI;
- rebase only right before merging.
