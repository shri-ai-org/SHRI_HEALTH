# Licence check (D75, issue #55)

CI fails if any package in our lockfiles has a licence that DECISIONS.md D75 doesn't allow.

| File | What it does |
|---|---|
| `allowed.json` | The allowed SPDX licences from D75, aliases for the non-SPDX names packages use, and package exceptions |
| `check-npm.mjs` | `contracts/` and `frontend/`, after `npm ci`. Reads each `package-lock.json` entry, falling back to the installed `package.json`, including the older `licenses` list |
| `check_python.py` | `backend/`, after installing `requirements-dev.lock`, which contains every runtime package too. Reads `License-Expression`, then the `License ::` classifiers, then the `License` field |

Both checks use only the standard library of Node and Python, so they add no dependency. They read SPDX expressions:
- `A OR B` passes if either side is allowed;
- `A AND B` passes only if both are;
- `A WITH exception` is judged by `A`.

CI runs them in `contracts.yml`, `frontend.yml` and `backend.yml`, right after installing. A change here runs all three.

## Adding to the list

- **A new allowed licence** changes D75 first. Then add it to `allowed` in the same PR.
- **A package that needs an exception** gets a line in D75's exceptions register first. Then add it under `packages` as `"npm:<name>"` or `"pypi:<name>"`, with:
  - `licence`: the licence we accept it under;
  - `register`: where that register line is.

  ```json
  "packages": {
    "npm:example": { "licence": "MIT", "register": "DECISIONS.md, licence exceptions register, line 'example'" }
  }
  ```

- **A package that declares no licence** fails until it has an exception entry. Never guess one.

Run locally:

```bash
cd frontend && npm ci --ignore-scripts && node ../.github/licences/check-npm.mjs
cd backend && pip install --require-hashes --no-deps -r requirements-dev.lock && python ../.github/licences/check_python.py
```
