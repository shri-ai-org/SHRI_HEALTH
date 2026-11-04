## What this changes

<!-- One or two sentences. Link the issue if there is one. -->

## Source screen (frontend PRs)

<!-- D115: existing screens first. Leave out for PRs that change no screen. -->

- Source screen (repo and path):
- Reuse level: ported / adapted / new, and the reason:

## Definition of done

- [ ] Contract exists (or was updated first) for every endpoint touched
- [ ] Uses `require()` and `tenant_db`; no security code inside the endpoint
- [ ] Tests: success, permission denied, validation error
- [ ] CI green, including contract and breaking-change checks
- [ ] No patient data in code, logs, fixtures or prompts
- [ ] Code owner approved
- [ ] Demoed on staging at the weekly review
