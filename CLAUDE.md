# Shri Health — rules for every Claude Code session

@docs/context/DECISIONS.md

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
