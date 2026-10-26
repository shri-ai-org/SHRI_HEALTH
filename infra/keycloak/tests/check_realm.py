"""Checks the staff realm against what SECURITY_MODEL §2.1, #35 and ADR-0006 require.

Standard library only. Without arguments it checks infra/keycloak/realms/shri-staff.json; with
--live it also asks a running Keycloak (that imported the file) for the same settings, so a
setting Keycloak drops or renames on import is caught too.

    python infra/keycloak/tests/check_realm.py
    KC_URL=http://127.0.0.1:8080/kc KC_ADMIN=admin KC_ADMIN_PASSWORD=... SHRI_WEB_CLIENT_SECRET=... \
        python infra/keycloak/tests/check_realm.py --live
"""

import json
import os
import sys
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

REALM_FILE = Path(__file__).resolve().parents[1] / "realms" / "shri-staff.json"

# Our timeouts (SECURITY_MODEL §2.1; Q20 pending) and Keycloak's backstop: ours plus 5 minutes (#35).
APP_IDLE_SECONDS = 15 * 60
APP_ABSOLUTE_SECONDS = 12 * 60 * 60
BACKSTOP_SECONDS = 5 * 60

REALM_RULES: dict[str, Any] = {
    "enabled": True,
    "registrationAllowed": False,  # staff accounts are created by ADM, never by sign-up
    "duplicateEmailsAllowed": False,
    "verifyEmail": True,
    "rememberMe": False,  # shared clinic workstations
    "bruteForceProtected": True,
    "permanentLockout": False,  # temporary lockouts only, so nobody can lock a colleague out
    "ssoSessionIdleTimeout": APP_IDLE_SECONDS + BACKSTOP_SECONDS,
    "ssoSessionMaxLifespan": APP_ABSOLUTE_SECONDS + BACKSTOP_SECONDS,
    "revokeRefreshToken": True,
    "refreshTokenMaxReuse": 0,
    "eventsEnabled": True,
    "adminEventsEnabled": True,
    "adminEventsDetailsEnabled": False,  # details can carry user data
}

CLIENT_RULES: dict[str, Any] = {
    "publicClient": False,
    "standardFlowEnabled": True,
    "implicitFlowEnabled": False,
    "directAccessGrantsEnabled": False,  # no password grant: sign-in only through Keycloak's pages
    "serviceAccountsEnabled": False,
    "consentRequired": False,
    "fullScopeAllowed": False,
}


def problems_in(realm: dict[str, Any], client: dict[str, Any], actions: list[dict[str, Any]],
                live: bool) -> list[str]:
    found = [f"realm {key} is {realm.get(key)!r}, must be {want!r}"
             for key, want in REALM_RULES.items() if realm.get(key) != want]
    policy = realm.get("passwordPolicy", "")
    for part in ("length(12)", "notUsername", "notEmail"):
        if part not in policy:
            found.append(f"passwordPolicy lacks {part}")
    if not 0 < realm.get("accessTokenLifespan", 0) <= 300:
        found.append("accessTokenLifespan must be at most 5 minutes")
    found += [f"client shri-web {key} is {client.get(key)!r}, must be {want!r}"
              for key, want in CLIENT_RULES.items() if client.get(key) != want]
    if client.get("attributes", {}).get("pkce.code.challenge.method") != "S256":
        found.append("client shri-web must require PKCE S256")
    for uri in client.get("redirectUris", []):
        if "*" in uri or not (uri.startswith("https://") or uri.startswith("${")):
            found.append(f"redirect URI {uri!r} must be an exact https URI")
    if not live and client.get("secret") != "${SHRI_WEB_CLIENT_SECRET}":
        found.append("the client secret must come from ${SHRI_WEB_CLIENT_SECRET}, never the file")
    totp = next((a for a in actions if a.get("alias") == "CONFIGURE_TOTP"), {})
    if not (totp.get("enabled") and totp.get("defaultAction")):
        found.append("CONFIGURE_TOTP must be an enabled default action (multi-factor for every new user)")
    return found


def from_file() -> list[str]:
    realm = json.loads(REALM_FILE.read_text(encoding="utf-8"))
    client = next(c for c in realm["clients"] if c["clientId"] == "shri-web")
    return problems_in(realm, client, realm.get("requiredActions", []), live=False)


def _get(url: str, token: str) -> Any:
    request = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(request, timeout=10) as response:  # noqa: S310 (local Keycloak)
        return json.load(response)


def from_keycloak() -> list[str]:
    base = os.environ["KC_URL"].rstrip("/")
    form = urllib.parse.urlencode({
        "client_id": "admin-cli", "grant_type": "password",
        "username": os.environ["KC_ADMIN"], "password": os.environ["KC_ADMIN_PASSWORD"],
    }).encode()
    with urllib.request.urlopen(  # noqa: S310 (local Keycloak)
        f"{base}/realms/master/protocol/openid-connect/token", data=form, timeout=10
    ) as response:
        token = json.load(response)["access_token"]
    admin = f"{base}/admin/realms/shri-staff"
    realm = _get(admin, token)
    client = _get(f"{admin}/clients?clientId=shri-web", token)[0]
    actions = _get(f"{admin}/authentication/required-actions", token)
    found = problems_in(realm, client, actions, live=True)
    secret = _get(f"{admin}/clients/{client['id']}/client-secret", token).get("value")
    if secret != os.environ["SHRI_WEB_CLIENT_SECRET"]:
        found.append("the imported client secret is not the one from SHRI_WEB_CLIENT_SECRET")
    return found


def main() -> int:
    found = [f"file: {p}" for p in from_file()]
    if "--live" in sys.argv:
        found += [f"live: {p}" for p in from_keycloak()]
    for problem in found:
        print(f"::error::Staff realm: {problem}")
    print(f"Staff realm check: {len(found)} problem(s).")
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main())
