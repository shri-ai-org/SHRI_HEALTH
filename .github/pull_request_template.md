## What this changes

<!-- One or two sentences. Link the issue if there is one. -->

## Definition of done

- [ ] Contract exists (or was updated first) for every endpoint touched
- [ ] Uses `require()` and `tenant_db`; no security code inside the endpoint
- [ ] Tests: success, permission denied, validation error
- [ ] CI green, including contract and breaking-change checks
- [ ] No patient data in code, logs, fixtures or prompts
- [ ] Code owner approved
- [ ] Demoed on staging at the weekly review
