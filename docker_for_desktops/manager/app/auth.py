"""Authentication and access control.

Rules enforced here:
  * Auto-login (default ON): a browser that reaches the manager is logged in as
    MANAGER_USER without any prompt, form or password field. HTTP Basic and the
    bearer token keep working unchanged for scripts and for anyone who wants
    them, but nothing forces the user to type a password.
  * When auto-login is off (MANAGER_AUTO_LOGIN=0) the API falls back to plain
    HTTP Basic: session URLs then require credentials.
  * One authenticated user may only reach the sessions they own, unless they
    hold the admin role. Session ids are not treated as secrets.
  * The REST API additionally accepts a bearer token for scripting.
  * WebSocket upgrades are checked with the same code path as HTTP requests,
    before the socket is accepted.
  * Passwords are compared in constant time and never appear in a URL.

Auto-login means "whoever can open the URL is the operator". That is the point
of this service on a local machine or behind an authenticating reverse proxy;
exposing it directly to a network without one removes the last barrier, so the
manager logs a loud warning and MANAGER_BIND stays 127.0.0.1 in .env.example.
"""
from __future__ import annotations

import hmac
import logging
import os
from typing import Optional

from fastapi import HTTPException, Request, WebSocket, status
from fastapi.security import HTTPBasic, HTTPBasicCredentials

from .store import Session

log = logging.getLogger("manager.auth")

security = HTTPBasic(auto_error=False)

# Role mapping: a session owner is listed here by name. Anyone else
# authenticating as a configured user is an admin.
ADMIN_USERS = {u for u in [os.environ.get("MANAGER_ADMIN_USER", "admin")] if u}


class Principal:
    def __init__(self, username: str, token_auth: bool = False, auto: bool = False) -> None:
        self.username = username
        self.token_auth = token_auth
        # auto = the caller was not asked for anything, auto-login vouched for
        # them. There is exactly one such identity, so it owns everything.
        self.auto = auto

    @property
    def is_admin(self) -> bool:
        return self.auto or self.username in ADMIN_USERS

    def may_access(self, session: Session) -> bool:
        return self.is_admin or session.owner == self.username

    def summary(self) -> dict:
        return {
            "username": self.username,
            "admin": self.is_admin,
            "auto_login": self.auto,
            "token_auth": self.token_auth,
        }

    def __repr__(self) -> str:  # pragma: no cover
        return f"Principal({self.username!r}, admin={self.is_admin}, auto={self.auto})"


class AuthSettings:
    def __init__(self, config) -> None:
        auth = config.get("manager.auth", {})
        self.username = str(auth.get("username") or "")
        self.password = str(auth.get("password") or "")
        self.api_token = str(auth.get("api_token") or "")
        self.auto_login = bool(auth.get("auto_login", True))
        # The identity a visitor is given without typing anything. Defaults to
        # MANAGER_USER so the browser session and a `curl -u` session are the
        # same user, and there is only ever one user to configure.
        self.auto_user = str(auth.get("auto_user") or self.username or "operator")

    @property
    def configured(self) -> bool:
        """The manager can serve requests: either auto-login or credentials."""
        if self.auto_login and self.auto_user:
            return True
        return bool(self.username and (self.password or self.api_token))

    @property
    def has_credentials(self) -> bool:
        """Password/token auth is available on top of (or instead of) auto-login."""
        return bool(self.username and (self.password or self.api_token))


_settings: Optional[AuthSettings] = None


def configure(config) -> AuthSettings:
    global _settings
    _settings = AuthSettings(config)
    if not _settings.configured:
        log.warning(
            "auto-login is off and no credentials are configured - the API is "
            "UNAUTHENTICATED. Set MANAGER_AUTO_LOGIN=1, or MANAGER_USER and "
            "MANAGER_PASSWORD, before exposing this service."
        )
    elif _settings.auto_login:
        log.info(
            "auto-login ON: the browser is logged in as %r with no password "
            "prompt. Basic auth%s still available.",
            _settings.auto_user,
            "" if _settings.has_credentials else " is NOT",
        )
    return _settings


def settings() -> AuthSettings:
    if _settings is None:
        raise RuntimeError("auth.configure() was never called")
    return _settings


def _check(credentials: Optional[HTTPBasicCredentials], token: Optional[str]) -> Optional[Principal]:
    s = settings()
    if not s.configured:
        return Principal(username="anonymous", token_auth=True)

    if token and s.api_token and hmac.compare_digest(token, s.api_token):
        return Principal(username=s.username, token_auth=True)

    if credentials is not None:
        user_ok = hmac.compare_digest(credentials.username.encode(), s.username.encode())
        pass_ok = hmac.compare_digest(credentials.password.encode(), s.password.encode())
        if user_ok and pass_ok:
            return Principal(username=credentials.username)
        # Stale or wrong credentials must not become a dead end: with
        # auto-login on, the browser simply continues as the auto user. That
        # also means a cached Basic prompt can never lock anyone out.
        log.debug(
            "credentials for %r did not match; falling back to auto-login",
            credentials.username,
        )

    if s.auto_login and s.auto_user:
        return Principal(username=s.auto_user, token_auth=True, auto=True)

    return None


def principal_from_request(request: Request) -> Optional[Principal]:
    creds = _parse_basic(request)
    token = request.headers.get("x-api-token") or _bearer(request)
    return _check(creds, token)


def principal_from_ws(websocket: WebSocket) -> Optional[Principal]:
    """Synchronous on purpose: the same code path must run before the
    WebSocket upgrade is accepted, and it must never await anything."""
    creds = _parse_basic_from_headers(websocket.headers)
    token = websocket.headers.get("x-api-token") or _bearer(websocket)
    return _check(creds, token)


def require_http(request: Request) -> Principal:
    p = principal_from_request(request)
    if p is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="authentication required",
            headers={"WWW-Authenticate": 'Basic realm="web-desktop"'},
        )
    request.state.principal = p
    return p


def require_ws(websocket: WebSocket) -> Principal:
    p = principal_from_ws(websocket)
    if p is None:
        # Close before accepting: the upgrade never happens.
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="authentication required",
            headers={"WWW-Authenticate": 'Basic realm="web-desktop"'},
        )
    websocket.state.principal = p
    return p


def require_session_access(principal: Principal, session: Session) -> None:
    if not principal.may_access(session):
        log.warning(
            "access denied: user=%r tried to reach session %s owned by %r",
            principal.username, session.id, session.owner,
        )
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="not your session")


# ----------------------------------------------------------------- helpers
def _bearer(req) -> Optional[str]:
    auth = req.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return None


def _parse_basic(request: Request) -> Optional[HTTPBasicCredentials]:
    header = request.headers.get("authorization", "")
    if not header.lower().startswith("basic "):
        return None
    return _decode_basic(header[6:].strip())


def _parse_basic_from_headers(headers) -> Optional[HTTPBasicCredentials]:
    header = headers.get("authorization", "")
    if not header.lower().startswith("basic "):
        return None
    return _decode_basic(header[6:].strip())


def _decode_basic(token: str) -> Optional[HTTPBasicCredentials]:
    import base64

    try:
        raw = base64.b64decode(token, validate=True).decode("utf-8")
    except Exception:  # noqa: BLE001
        return None
    if ":" not in raw:
        return None
    user, _, password = raw.partition(":")
    return HTTPBasicCredentials(username=user, password=password)
