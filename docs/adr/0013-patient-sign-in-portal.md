# ADR-0013: Patient sign-in for the portal

Status: **Proposed** · 2026-10-26 · Author: Thulasi (drafted with Claude Code) · **Needs sign-off from:** Thulasi (owner, D3), Vimal (portal contract, D83), Anand (schema, and the messages, bills and documents the portal shows), Minalini (portal screens, #39)
Answers: issue #65. Builds on: DECISIONS.md D84 (patient role `PAT`, own record only) and D85 (separate realm, multi-factor, invitation-only enrolment, proxy access P2); [ADR-0006](0006-cookie-session-and-csrf.md) (session cookie, reference token, CSRF), #35 (Keycloak logout, expiry, `prompt=login`, keep-alive).
Scope: P1 (D19, D88). Nothing here is built before the portal contract (batch B8).

## Context

The portal opens a patient's whole chart to the internet: results, notes, medications, messages and bills. Whoever holds a portal account for a chart can read all of it. So the account must be tied to the right person, the sign-in must survive stolen and reused passwords, and nothing a stranger can learn (a name, a date of birth, an email address) may be enough to get in or to learn that an account or a chart exists.

Staff sign-in (ADR-0006) is the model, but patients differ in four ways:
- **They sign in from home,** on devices we don't control, on the open internet.
- **They can't be checked by an administrator at hiring;** only the front desk sees their ID.
- **They forget passwords and lose phones,** and recovery is the usual way accounts are taken over.
- **A patient session must never be able to reach a staff endpoint,** and the reverse.

## Decision

### 1. A separate realm, client and origin

- **Realm `shri-patients`**, separate from the staff realm. It has no staff users, roles, clients, identity providers or session store in common with staff. Its admin console isn't reachable from the internet. Our API reaches it only through one service account with `manage-users` and `view-users` in that realm and nothing else, used for enrolment and for the front-desk multi-factor reset (§4).
- **One client, `shri-portal-web`:** confidential, authorization code with PKCE (`S256`), `state` and `nonce`, server-side as in ADR-0006 §1. Exact redirect URI `https://<portal host>/api/v1/portal/auth/callback`. No implicit or password grants, no direct access grants, no front-channel tokens. Tokens are kept server-side, encrypted (`vault:v…`), as for staff.
- **The portal has its own host** (`portal.<company domain>`, Q3), with its own Nginx server block:
  - it serves only the portal app, `/api/v1/portal/*`, the patient realm under `/kc/` (never the staff realm) and `/source.tar.gz` (D87);
  - its own CSP, with `frame-ancestors 'none'`;
  - its own host-only cookie.

  A staff cookie is never sent to the portal host, and the reverse, so neither can be used on the other's routes even by mistake.
- **Self-registration in the realm is off.** A realm account is created only by enrolment (§3). The username is the email address, verified before first sign-in.

### 2. Multi-factor for every patient, every sign-in

- **Factors:**
  - **WebAuthn** (passkeys, security keys) is offered first.
  - **TOTP** (an authenticator app) is the fallback.
  - **SMS and email one-time codes are not second factors.** SIM swap and mailbox takeover are the commonest ways in.
- **Every sign-in needs the second factor.** There's no "remember this device" in P1, because shared home computers are common.
- **Recovery codes:** 10 single-use codes, shown once when multi-factor is set up (Keycloak's recovery authentication codes). Using one prompts the patient to set up a new factor.
- **Lost every factor:** the patient comes back to the front desk with ID. ADM or FD, after the ID check, uses "Reset sign-in factors" (a staff action, audited, §6), and the patient sets up new factors at the next sign-in. Factors are never reset by email, phone or a support call.
- **Password:**
  - at least 12 characters;
  - not the email address;
  - checked against a list of breached passwords;
  - hashed by Keycloak (Argon2id).
- **Brute force:** Keycloak's detection is on, with temporary lockouts that grow (5 failures, then waits up to 15 minutes). There's no permanent lockout, which would let anyone lock a patient out. Nginx also rate-limits `/kc/` and `/api/v1/portal/auth/*` per IP.

### 3. Enrolment by invitation code only

1. **Issue (front desk, in person, after an ID check):** `POST /patients/{patientId}/portal-invitations` (staff contract; permission `portal-invitations:create`, FD and ADM). The response shows the code **once**. It's printed or read out at the desk, never emailed or texted.
   - **Code:** 12 characters, Crockford base32, grouped `XXXX-XXXX-XXXX` (60 bits of randomness from `secrets`).
   - **Storage:** an HMAC-SHA256 of the code with a key from OpenBao, never the code itself.
   - **Expiry:** 72 hours, single use. One active invitation per patient: issuing a new one revokes the old one. `POST …/portal-invitations/{id}/revoke` is under the same permission.
2. **Redeem (patient, at home):** the portal's "Set up your account" page sends the code, the patient's date of birth and the email address they want to use to `POST /api/v1/portal/enrolments`.
   - The date of birth isn't a secret. It only stops a code that someone saw over a shoulder from being used by anyone else.
   - The API checks all three in one constant-time path and answers the same "We couldn't use that code" for every failure: unknown, expired, used, revoked, or date of birth doesn't match.
   - It's rate-limited per IP and per invitation, and an invitation is revoked after 5 failed tries.
3. **Account creation:** on success, in one transaction:
   - the invitation is marked used;
   - our API creates the realm user through the service account, with required actions verify-email, set-password and set-up-second-factor;
   - it records the link `keycloak_user_id → patient` (§5);
   - it asks Keycloak to send its "set up your account" email (link valid 12 hours).

   The patient sets their password and second factor **in Keycloak, never in our API** (D3). Until the required actions are done, the account can't sign in.
4. **Notice to the chart's contacts:** when enrolment completes, the email and phone already on the chart (not the ones just typed) get "A portal account was set up for you at <clinic>. If this wasn't you, call the clinic." A hijacked invitation then can't go unnoticed.
5. **One account, one chart, in P1.** A patient with charts at two clinics enrols at each with a different email. Proxy access (parents, caregivers) and one account linking several charts are P2 (D85). The link table (§5) is many-to-one now, so P2 can add links without changing it.

### 4. Password reset and username recovery

- **Done by the patient realm, not our API** (D3). "Forgot password" sends a reset link to the verified email.
- **The page always says the same thing,** "If that address has an account, we've sent a link", whether or not it does, with the same timing. It's rate-limited per IP and per address.
- **A reset never removes the second factor.** The next sign-in still asks for it.
- **The username is the email address,** so there's no separate username recovery. A patient who doesn't remember which email they used comes to the front desk, which can see the email on the portal link without seeing the password.

### 5. How the API knows a patient session

- **Portal routes:** `/api/v1/portal/auth/login`, `/callback`, `/session`, `/refresh`, `/logout` and `/enrolments`. They mirror the staff routes (ADR-0006), with their own cookie `__Host-shri_portal` (`HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`, no `Domain`, 256-bit reference token, stored only as a SHA-256 hash). Login sends `prompt=login`. Logout and expiry end the Keycloak session over the back channel, as #35 does for staff.
- **Separate tables** (Anand, in a migration):
  - `admin.portal_invitation`: patient, clinic, the code's HMAC, issued by, expiry, used and revoked times;
  - `admin.portal_account`: the Keycloak user ID (unique), patient, clinic, status;
  - `admin.portal_session`: the `app_session` columns for patients, with `patient_id` instead of `user_id`.

  A staff session lookup can never return a patient session, and the reverse: each has its own `SECURITY DEFINER` lookup, granted to `shri_app` only. The retention purge covers `portal_session` and used or expired invitations.
- **Core** adds `current_patient` and `tenant_db` for portal sessions:
  - the clinic and the patient come from the session row only (D84);
  - `app.current_tenant_id` is set as for staff, with `app.current_patient_id` added;
  - role `PAT`, with only portal permissions (B8).
  - **Staff routes refuse portal sessions** and portal routes refuse staff sessions, checked in core, not in each endpoint.
- **Own record only:** a shared core dependency checks that any record ID in a portal path belongs to the session's patient, before the endpoint runs. Otherwise it returns `404` (not `403`), so a patient can't learn that someone else's record exists (D84). Restricted charts (D37) don't apply to the patient's own chart, but a record held by a clinician (D86) isn't shown.
- **Timeouts (proposed; final values with Q20):**
  - idle 15 minutes, with the same warning and "Stay signed in" as staff;
  - absolute **4 hours** (portal visits are short, and a longer limit only helps an attacker on a shared home computer).

  Keycloak's patient-realm idle and maximum are ours plus 5 minutes, with keep-alive on user activity (#35).
- **CSRF:** as ADR-0006 §4, an HMAC of the portal session with its own key. `Origin` must be the portal host.

### 6. What is audited

| Event | Category | Actor | Recorded |
|---|---|---|---|
| Invitation issued or revoked | `security` | Staff user | Patient, invitation ID, expiry; never the code |
| Enrolment attempt, success or failure | `security` | `patient` (success), or clinic-less `access-denied` (failure, A47) | Invitation ID if known, IP, request ID; never the code, the date of birth or the email typed |
| Sign-in and sign-out, session expiry, refresh refused | `security` | `patient` | Patient, session ID, IP |
| Second-factor reset by staff | `security` | Staff user | Patient, staff user, the ID check confirmed |
| Every portal read of patient data | `phi-read` | `patient` | Patient, resource, as staff reads are |
| Patient-initiated writes (messages, requests, payments) | `phi-write` | `patient` | As above |

Keycloak's own event log for the patient realm (login failures, password resets, factor changes) is on and kept for 90 days. A failed patient sign-in that never reaches our API is recorded there.

### 7. Threat model

| Threat | Main defenses |
|---|---|
| **Account takeover** by reused or phished passwords | Multi-factor on every sign-in, WebAuthn first; breached-password check; brute-force detection and rate limits; no SMS or email second factor |
| **Account takeover** through recovery | Reset never removes the second factor; factors reset only at the front desk with ID; recovery codes shown once |
| **Enrolment by a stranger** (knows name and date of birth) | Enrolment needs an invitation code issued in person; name and date of birth alone never link an account (D85) |
| **Invitation interception or reuse** | Given only in person; 72 hours; single use; one active per patient; revoked after 5 failed tries; date of birth checked with it; stored only as HMAC; notice sent to the chart's existing contacts |
| **Enumeration** (does this person have an account, or a chart here?) | The same answer and timing for every enrolment and reset failure; rate limits; record IDs owned by someone else give `404` |
| **One patient reading another's records** | No patient ID in any portal request (D84); the shared ownership check before every endpoint; RLS by clinic underneath |
| **A patient session reaching staff data, or a staff session the portal** | Separate realm, host, cookie, session table and lookup function; route guards in core |
| **Session theft** | `__Host-` cookie, `HttpOnly`, `Secure`, `SameSite=Strict`; host-only on the portal host; 15 minutes idle and 4 hours absolute; new session ID at every login; tokens never in the browser |
| **CSRF and clickjacking** | `X-CSRF-Token` with `Origin` checked; CSP `frame-ancestors 'none'` |
| **Login flooding** | Nginx and app rate limits; Keycloak's temporary lockouts, never permanent |

## Alternatives considered

| Option | Why not |
|---|---|
| One realm for staff and patients, told apart by role | A misconfigured client, role or identity provider could let one population in as the other; staff password and factor policies would apply to patients, or the reverse |
| Self-registration that matches name and date of birth to a chart | A name and birth date aren't secret, and a match opens a whole chart (D85) |
| SMS or email one-time codes as the second factor | SIM swap and mailbox takeover; email is also where password resets go, so it would be one factor twice |
| Invitation by email or text message | Interception, and sending to an outdated contact; in person after an ID check is the only point where we know who the person is |
| Portal on the staff host, under a path | The browser would send the staff cookie to portal pages and the reverse; one CSP for both; a single Nginx mistake would expose the staff realm |
| Our API sets passwords and second factors | It would make our API a credential store, against D3 |

## Consequences

- **Thulasi:**
  - realm export and client in `infra/keycloak/` (the patient realm next to the staff realm);
  - the portal Nginx server block;
  - core's portal session, `current_patient`, route guards, the ownership check, the enrolment endpoint and the multi-factor reset;
  - rate limits;
  - the B8 permissions and SECURITY_MODEL rows, landed together.
- **Vimal:**
  - in the staff contract: `POST /patients/{patientId}/portal-invitations` and `…/revoke` (`portal-invitations:create`; FD, ADM), and `POST /patients/{patientId}/portal-account/reset-factors` (ADM, FD after ID check);
  - in `portal.yaml`: the portal auth routes and `POST /portal/enrolments`.
- **Anand:** `portal_invitation`, `portal_account` and `portal_session`, their lookup function, and purge coverage, in one migration.
- **Minalini:**
  - the enrolment page (code, date of birth, email);
  - the factor setup and sign-in pages (served by Keycloak with our theme);
  - "Reset sign-in factors" and "Print invitation" on the staff patient page;
  - the portal session handling, as `session.tsx`.

  Her draft (#39) drops its own sign-in, registration and password pages, as she noted on #66.
- **Open, to settle before B8:**
  - the portal timeouts (Q20, clinical advisors);
  - the invitation lifetime;
  - the portal host name (Q3);
  - whether practices may also print the invitation on the visit summary.

## References

DECISIONS.md D3, D13, D19, D37, D72, D84–D88; ADR-0005, ADR-0006; SECURITY_MODEL §2, §6, §9; issues #13 (A47), #35, #65; PR #39, #66.
