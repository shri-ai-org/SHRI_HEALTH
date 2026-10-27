"""Checks the staff realm against what SECURITY_MODEL §2.1, #35 and ADR-0006 require.

Standard library only. Without arguments it checks infra/keycloak/realms/shri-staff.json; with
--live it also asks a running Keycloak (that imported the file) for the same settings, so a
setting Keycloak drops or renames on import is caught too.

    python infra/keycloak/tests/check_realm.py
    KC_URL=http://127.0.0.1:8080/kc KC_ADMIN=admin KC_ADMIN_PASSWORD=... SHRI_WEB_CLIENT_SECRET=... \
        python infra/keycloak/tests/check_realm.py --live
"""

import http.cookiejar
import json
import os
import re
import secrets
import sys
import urllib.error
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


STAFF_FLOW = "shri browser"
NOT_ALLOWED_SCOPES = {"offline_access"}  # a way around the 12-hour maximum (Vimal, #72)


def flow_problems(steps: list[tuple[str, str]]) -> list[str]:
    """steps: (authenticator, requirement) in the staff sign-in flow, sub-flows included."""
    found = []
    for authenticator in ("auth-username-password-form", "auth-otp-form"):
        if (authenticator, "REQUIRED") not in steps:
            found.append(f"the staff sign-in flow must have {authenticator} REQUIRED (#72)")
    if any(requirement == "CONDITIONAL" for _, requirement in steps):
        found.append("the staff sign-in flow must not have a CONDITIONAL step: the code is asked every time")
    return found


def scope_problems(default: list[str], optional: list[str]) -> list[str]:
    found = [f"client shri-web must not offer the {name} scope"
             for name in sorted(NOT_ALLOWED_SCOPES & set(default + optional))]
    if optional:
        found.append(f"client shri-web must have no optional scopes, has {sorted(optional)}")
    return found


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
    if realm.get("browserFlow") != STAFF_FLOW:
        found.append(f"browserFlow is {realm.get('browserFlow')!r}, must be {STAFF_FLOW!r}")
    totp = next((a for a in actions if a.get("alias") == "CONFIGURE_TOTP"), {})
    if not (totp.get("enabled") and totp.get("defaultAction")):
        found.append("CONFIGURE_TOTP must be an enabled default action (multi-factor for every new user)")
    return found


def from_file() -> list[str]:
    realm = json.loads(REALM_FILE.read_text(encoding="utf-8"))
    client = next(c for c in realm["clients"] if c["clientId"] == "shri-web")
    found = problems_in(realm, client, realm.get("requiredActions", []), live=False)
    flows = {f["alias"]: f for f in realm.get("authenticationFlows", [])}

    def steps(alias: str) -> list[tuple[str, str]]:
        out = []
        for e in flows.get(alias, {}).get("authenticationExecutions", []):
            if e.get("authenticatorFlow"):
                out += [(e["flowAlias"], e["requirement"])] + steps(e["flowAlias"])
            else:
                out.append((e["authenticator"], e["requirement"]))
        return out

    found += flow_problems(steps(STAFF_FLOW))
    found += scope_problems(client.get("defaultClientScopes", []), client.get("optionalClientScopes", []))
    return found


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
    flow = urllib.parse.quote(realm.get("browserFlow", ""))
    executions = _get(f"{admin}/authentication/flows/{flow}/executions", token)
    found += flow_problems([(e.get("providerId") or e.get("displayName", ""), e["requirement"])
                            for e in executions])
    found += scope_problems(
        [s["name"] for s in _get(f"{admin}/clients/{client['id']}/default-client-scopes", token)],
        [s["name"] for s in _get(f"{admin}/clients/{client['id']}/optional-client-scopes", token)])
    found += signs_in_without_code(base, admin, token)
    secret = _get(f"{admin}/clients/{client['id']}/client-secret", token).get("value")
    if secret != os.environ["SHRI_WEB_CLIENT_SECRET"]:
        found.append("the imported client secret is not the one from SHRI_WEB_CLIENT_SECRET")
    return found


def signs_in_without_code(base: str, admin: str, token: str) -> list[str]:
    """Signs in a synthetic user who has a password but no one-time code (as if it had been
    removed) and checks that Keycloak sends them to set one up instead of signing them in. The
    user is deleted afterwards. Only against a throwaway Keycloak (CI, local)."""

    def call(method: str, path: str, body: Any = None) -> Any:
        request = urllib.request.Request(
            f"{admin}{path}", method=method, data=None if body is None else json.dumps(body).encode(),
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=10) as response:  # noqa: S310
            raw = response.read()
            return json.loads(raw) if raw else None

    name, password = f"synthetic.{secrets.token_hex(4)}", secrets.token_urlsafe(18)
    call("POST", "/users", {"username": name, "email": f"{name}@example.invalid", "firstName": "Synthetic",
                            "lastName": "Staff", "enabled": True, "emailVerified": True})
    user_id = call("GET", f"/users?username={name}&exact=true")[0]["id"]
    try:
        call("PUT", f"/users/{user_id}/reset-password", {"type": "password", "value": password, "temporary": False})
        call("PUT", f"/users/{user_id}", {"requiredActions": []})  # as if the code had been removed
        jar = http.cookiejar.CookieJar()

        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *args: Any, **kwargs: Any) -> None:
                return None

        browser = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar), NoRedirect)
        query = urllib.parse.urlencode({
            "client_id": "shri-web", "response_type": "code", "scope": "openid", "state": "check",
            "nonce": "check", "redirect_uri": "https://localhost:8443/api/v1/auth/callback",
            "code_challenge": "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", "code_challenge_method": "S256"})
        page = browser.open(f"{base}/realms/shri-staff/protocol/openid-connect/auth?{query}").read().decode()
        for cookie in jar:
            cookie.secure = False  # the throwaway Keycloak is plain http
        form = re.search(r'id="kc-form-login"[^>]*action="([^"]+)"', page)
        if not form:
            return ["live: the staff sign-in page has no login form"]
        try:
            browser.open(form.group(1).replace("&amp;", "&"),
                         urllib.parse.urlencode({"username": name, "password": password}).encode())
            location = ""
        except urllib.error.HTTPError as redirect:
            location = redirect.headers.get("Location", "")
        if "code=" in location:
            return ["a user with a password and no one-time code was signed in (#72)"]
        if "execution=CONFIGURE_TOTP" not in location:
            return [f"a user without a one-time code was not sent to set one up ({location[:80]!r})"]
        return []
    finally:
        call("DELETE", f"/users/{user_id}")


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
