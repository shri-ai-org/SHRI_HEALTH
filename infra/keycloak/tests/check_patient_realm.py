"""Checks the patient realm (infra/keycloak/realms/shri-patients.json) against ADR-0013 §1-§4.

Standard library only:  python infra/keycloak/tests/check_patient_realm.py
Exit 1 with one line per problem. What it checks:
- no self-registration; email as username, verified; no "remember me";
- the one-time code REQUIRED on every sign-in and after a password reset (no CONDITIONAL step);
- brute-force protection with temporary lockouts only;
- Keycloak's idle and maximum are ours plus 5 minutes (15 minutes idle, 4 hours absolute);
- shri-portal-web: confidential, code flow with PKCE S256 only, an exact https redirect URI,
  its secret from the environment, no offline access;
- shri-portal-admin: a service account only, with manage-users and view-users in this realm
  and nothing else.
"""

import json
import sys
from pathlib import Path
from typing import Any

REALM_FILE = Path(__file__).resolve().parents[1] / "realms" / "shri-patients.json"

APP_IDLE_SECONDS = 15 * 60
APP_ABSOLUTE_SECONDS = 4 * 60 * 60
BACKSTOP_SECONDS = 5 * 60
SIGN_IN_FLOW = "shri patient browser"
RESET_FLOW = "shri patient reset"

REALM_RULES: dict[str, Any] = {
    "realm": "shri-patients",
    "enabled": True,
    "registrationAllowed": False,  # an account only through enrolment (ADR-0013 §3)
    "registrationEmailAsUsername": True,
    "verifyEmail": True,
    "duplicateEmailsAllowed": False,
    "rememberMe": False,  # shared home computers
    "editUsernameAllowed": False,
    "resetPasswordAllowed": True,  # by the realm, with the code still required (§4)
    "bruteForceProtected": True,
    "permanentLockout": False,  # nobody can lock a patient out
    "ssoSessionIdleTimeout": APP_IDLE_SECONDS + BACKSTOP_SECONDS,
    "ssoSessionMaxLifespan": APP_ABSOLUTE_SECONDS + BACKSTOP_SECONDS,
    "revokeRefreshToken": True,
    "refreshTokenMaxReuse": 0,
    "offlineSessionIdleTimeout": 0,
    "eventsEnabled": True,
    "adminEventsEnabled": True,
    "adminEventsDetailsEnabled": False,  # details can carry patient data
    "browserFlow": SIGN_IN_FLOW,
    "resetCredentialsFlow": RESET_FLOW,
}

WEB_RULES: dict[str, Any] = {
    "publicClient": False,
    "standardFlowEnabled": True,
    "implicitFlowEnabled": False,
    "directAccessGrantsEnabled": False,
    "serviceAccountsEnabled": False,
    "consentRequired": False,
    "fullScopeAllowed": False,
}

ADMIN_RULES: dict[str, Any] = {
    "publicClient": False,
    "standardFlowEnabled": False,
    "implicitFlowEnabled": False,
    "directAccessGrantsEnabled": False,
    "serviceAccountsEnabled": True,
    "fullScopeAllowed": False,
}
ADMIN_ROLES = {"manage-users", "view-users"}


def _steps(flows: dict[str, Any], alias: str) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for e in flows.get(alias, {}).get("authenticationExecutions", []):
        if e.get("authenticatorFlow"):
            out += [(e["flowAlias"], e["requirement"])] + _steps(flows, e["flowAlias"])
        else:
            out.append((e["authenticator"], e["requirement"]))
    return out


def problems(realm: dict[str, Any]) -> list[str]:
    found = [f"realm {key} is {realm.get(key)!r}, must be {want!r}"
             for key, want in REALM_RULES.items() if realm.get(key) != want]
    policy = realm.get("passwordPolicy", "")
    found += [f"passwordPolicy lacks {part}" for part in ("length(12)", "notUsername", "notEmail")
              if part not in policy]
    if not 0 < realm.get("accessTokenLifespan", 0) <= 300:
        found.append("accessTokenLifespan must be at most 5 minutes")

    flows = {f["alias"]: f for f in realm.get("authenticationFlows", [])}
    for alias, needed in ((SIGN_IN_FLOW, ("auth-username-password-form", "auth-otp-form")),
                          (RESET_FLOW, ("reset-credential-email", "reset-password",
                                        "auth-otp-form"))):
        steps = _steps(flows, alias)
        found += [f"flow {alias!r} must have {name} REQUIRED" for name in needed
                  if (name, "REQUIRED") not in steps]
        if any(requirement == "CONDITIONAL" for _, requirement in steps):
            found.append(f"flow {alias!r} must not have a CONDITIONAL step: the code is asked "
                         "every time")
    totp = next((a for a in realm.get("requiredActions", []) if a.get("alias") == "CONFIGURE_TOTP"),
                {})
    if not (totp.get("enabled") and totp.get("defaultAction")):
        found.append("CONFIGURE_TOTP must be an enabled default action")

    clients = {c["clientId"]: c for c in realm.get("clients", [])}
    if set(clients) != {"shri-portal-web", "shri-portal-admin"}:
        found.append(f"the realm's clients must be shri-portal-web and shri-portal-admin only, "
                     f"are {sorted(clients)}")
    web, admin = clients.get("shri-portal-web", {}), clients.get("shri-portal-admin", {})
    found += [f"client shri-portal-web {k} is {web.get(k)!r}, must be {v!r}"
              for k, v in WEB_RULES.items() if web.get(k) != v]
    if web.get("attributes", {}).get("pkce.code.challenge.method") != "S256":
        found.append("client shri-portal-web must require PKCE S256")
    for uri in web.get("redirectUris", []):
        if "*" in uri or not (uri.startswith("https://") or uri.startswith("${")):
            found.append(f"redirect URI {uri!r} must be an exact https URI")
    if web.get("secret") != "${SHRI_PORTAL_CLIENT_SECRET}":
        found.append("shri-portal-web's secret must come from ${SHRI_PORTAL_CLIENT_SECRET}")
    if "offline_access" in web.get("defaultClientScopes", []) + web.get("optionalClientScopes", []):
        found.append("client shri-portal-web must not offer offline_access")
    found += [f"client shri-portal-admin {k} is {admin.get(k)!r}, must be {v!r}"
              for k, v in ADMIN_RULES.items() if admin.get(k) != v]
    if admin.get("secret") != "${SHRI_PORTAL_ADMIN_CLIENT_SECRET}":
        found.append("shri-portal-admin's secret must come from ${SHRI_PORTAL_ADMIN_CLIENT_SECRET}")
    account = next((u for u in realm.get("users", [])
                    if u.get("serviceAccountClientId") == "shri-portal-admin"), None)
    if account is None:
        found.append("shri-portal-admin's service account user is missing")
    else:
        roles = account.get("clientRoles", {})
        if set(roles) != {"realm-management"} or set(roles["realm-management"]) != ADMIN_ROLES:
            found.append(f"shri-portal-admin may hold only realm-management {sorted(ADMIN_ROLES)}, "
                         f"holds {roles}")
        if account.get("realmRoles"):
            found.append("shri-portal-admin must hold no realm roles")
    # fullScopeAllowed is off, so the token carries only the roles mapped here: these two.
    scoped = {role for m in realm.get("clientScopeMappings", {}).get("realm-management", [])
              if m.get("client") == "shri-portal-admin" for role in m.get("roles", [])}
    if scoped != ADMIN_ROLES:
        found.append(f"shri-portal-admin's token scope must be {sorted(ADMIN_ROLES)}, is "
                     f"{sorted(scoped)}")
    if [u for u in realm.get("users", []) if not u.get("serviceAccountClientId")]:
        found.append("the realm file must hold no patient accounts: they come from enrolment")
    return found


def main() -> int:
    found = problems(json.loads(REALM_FILE.read_text(encoding="utf-8")))
    for problem in found:
        print(f"::error::Patient realm (ADR-0013): {problem}")
    print(f"Patient realm check: {len(found)} problem(s).")
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main())
