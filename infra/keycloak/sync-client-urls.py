"""Keeps the sign-in clients' URLs in step with the deploy's public address (deploy.sh up).

Keycloak imports a realm file only when the realm doesn't exist yet, so the redirect and
post-logout URLs in realms/*.json are fixed at the first start. When the public address changes
(a host of its own, a path under a shared host, a new name), this sets them again through the
admin API on the host's loopback. Only those two settings of these two clients change; a realm
that doesn't exist yet (shri-patients, #148) is skipped.

    KC_URL=http://127.0.0.1:8081/kc KC_ADMIN=admin KC_ADMIN_PASSWORD=... PUBLIC_URL=https://... \
        python3 -I infra/keycloak/sync-client-urls.py

Standard library only. The admin password comes from the environment, never the command line,
and no token or password is printed.
"""

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

KC = os.environ["KC_URL"].rstrip("/")
if urllib.parse.urlsplit(KC).scheme not in ("http", "https"):
    sys.exit("KC_URL must be http(s)://")  # so urlopen never opens file: or another scheme
PUBLIC = os.environ["PUBLIC_URL"].rstrip("/")

# realm, client, redirect URI, post-logout URI (the deploy overlay's SHRI_*_URI, by public URL)
CLIENTS = (
    ("shri-staff", "shri-web", f"{PUBLIC}/api/v1/auth/callback", f"{PUBLIC}/"),
    ("shri-patients", "shri-portal-web", f"{PUBLIC}/api/v1/portal/auth/callback",
     f"{PUBLIC}/portal/"),
)


def _token() -> str:
    form = urllib.parse.urlencode({
        "grant_type": "password", "client_id": "admin-cli", "username": os.environ["KC_ADMIN"],
        "password": os.environ["KC_ADMIN_PASSWORD"]}).encode()
    with urllib.request.urlopen(f"{KC}/realms/master/protocol/openid-connect/token",  # noqa: S310
                                form, timeout=15) as reply:
        token: str = json.load(reply)["access_token"]
        return token


def _call(token: str, method: str, path: str, body: Any = None) -> Any:
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(f"{KC}/admin/realms/{path}", data=data, method=method,  # noqa: S310
                                     headers={"Authorization": f"Bearer {token}",
                                              "Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=15) as reply:  # noqa: S310 (KC_URL checked above)
        raw = reply.read()
        return json.loads(raw) if raw else None


def main() -> int:
    token = _token()
    for realm, client_id, redirect, post_logout in CLIENTS:
        try:
            found = _call(token, "GET", f"{realm}/clients?clientId={client_id}")
        except urllib.error.HTTPError as err:
            if err.code == 404:
                print(f"{realm}: the realm doesn't exist yet; skipped")
                continue
            raise
        if not found:
            print(f"{realm}/{client_id}: no such client; skipped")
            continue
        client = found[0]
        attributes = client.setdefault("attributes", {})
        if (client.get("redirectUris") == [redirect]
                and attributes.get("post.logout.redirect.uris") == post_logout):
            print(f"{realm}/{client_id}: already {redirect}")
            continue
        client["redirectUris"] = [redirect]
        attributes["post.logout.redirect.uris"] = post_logout
        _call(token, "PUT", f"{realm}/clients/{client['id']}", client)
        print(f"{realm}/{client_id}: now {redirect}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
