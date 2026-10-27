# Licence check (D75, issue #55)

CI fails if any package in our lockfiles has a licence that DECISIONS.md D75 doesn't allow.

| File | What it does |
|---|---|
| `allowed.json` | The licences D75 allows for code; the fonts-and-data licences; aliases for non-SPDX names; and the per-package entries |
| `check-npm.mjs` | `contracts/` and `frontend/`, after `npm ci`. Reads each `package-lock.json` entry, falling back to the installed `package.json`, including the older `licenses` list |
| `check_images.py` | Third-party container images in `infra/compose/docker-compose.yml` and the workflows (OpenBao, nginx), against `images` |
| `check_python.py` | `backend/`, after installing `requirements-dev.lock`, which contains every runtime package too. Reads `License-Expression`, then the `License ::` classifiers, then the `License` field |

Both checks use only the standard library of Node and Python, so they add no dependency. Their rules are the same; keep them in step. They read SPDX expressions:
- `A OR B` passes if either side is allowed;
- `A AND B` passes only if both are;
- `A WITH exception` is judged by `A`.

A missing or unparseable licence fails.

CI runs them in `contracts.yml`, `frontend.yml` and `backend.yml`, right after installing. A change here runs all three.

## What `allowed.json` holds

- **`allowed`:** the D75 list for code, exactly as D75 names it.
- **`fonts_and_data.licences`:** OFL for fonts; CC0, CC-BY and CDLA-Permissive-2.0 for data and model weights. D75 allows these **only** for fonts and data. So they pass only for a package listed under `packages` with kind `font` or `data`, never for a code library.
- **`not_packages`:** what D75 allows by name that isn't a package (LOINC), so the file and D75 visibly match.
- **`packages`:** one entry per package that needs more than `allowed`. Each entry is checked before any package is:

  | `kind` | `licence` | `register` must name |
  |---|---|---|
  | `font` | one of the fonts-and-data licences | `D75` |
  | `data` | one of the fonts-and-data licences | `D75` |
  | `exception` | the licence the exception covers | its line in D75's **licence exceptions register** |

  The entry adds its one licence to what that package may use. The package's real licence is still read, so if it changes to something else, the check fails.

## Container images

`images` lists every third-party image we run but don't build (`shri-health/…` images are ours, from pinned Dockerfiles). Each entry has:
- a licence from `allowed`;
- the version tag;
- the `sha256` digest it's pinned to;
- where it's used, and where its licence comes from.

Every reference in compose and the workflows must be exactly `name:version@digest`, so an unlisted image, a moved tag or a missing pin fails CI. A new image, or a new version of one, follows the 7-day rule (a release at least 7 days old) and changes its entry in the same PR.

## Adding to it

- **A new allowed licence** changes D75 first, then `allowed` in the same PR.
- **A font or a data package:** add an entry with kind `font` or `data`.
- **Anything else:** first a line in D75's licence exceptions register, then an entry with kind `exception` that names that line.

  ```json
  "npm:example": { "kind": "exception", "licence": "LicenseRef-Example", "register": "DECISIONS.md, licence exceptions register: example" }
  ```

- **A package that declares no licence** fails until its licence is known. Never guess one.

Run locally:

```bash
cd frontend && npm ci --ignore-scripts && node ../.github/licences/check-npm.mjs
cd backend && pip install --require-hashes --no-deps -r requirements-dev.lock && python ../.github/licences/check_python.py
```
