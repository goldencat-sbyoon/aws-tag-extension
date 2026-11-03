"""API Gateway HTTP API Lambda Authorizer (payload 2.0, simple response)."""
import json
import os

import jwt
from jwt import PyJWKClient

_jwks_client = None


def _denied():
    return {"isAuthorized": False}


def lambda_handler(event, context):
    global _jwks_client
    try:
        issuer = os.environ["AUTH_ISSUER"]
        audience = os.environ["AUTH_AUDIENCE"]
        jwks_url = os.environ["AUTH_JWKS_URL"]
        required_scope = os.environ.get("AUTH_REQUIRED_SCOPE", "tag-policy:read")
        if not issuer.startswith("https://") or not jwks_url.startswith("https://"):
            return _denied()

        headers = {k.lower(): v for k, v in event.get("headers", {}).items()}
        scheme, _, token = headers.get("authorization", "").partition(" ")
        if scheme.lower() != "bearer" or not token or len(token) > 8192:
            return _denied()
        if _jwks_client is None:
            _jwks_client = PyJWKClient(jwks_url, cache_jwk_set=True, lifespan=300)

        public_key = _jwks_client.get_signing_key_from_jwt(token).key
        claims = jwt.decode(
            token, public_key, algorithms=["RS256"], audience=audience,
            issuer=issuer, options={"require": ["exp", "iat", "sub"]}, leeway=30,
        )
        scopes = claims.get("scope", claims.get("scp", ""))
        scopes = scopes.split() if isinstance(scopes, str) else scopes
        if not isinstance(scopes, list) or required_scope not in scopes:
            return _denied()
        groups = claims.get("groups", [])
        if not isinstance(groups, list) or not all(isinstance(g, str) for g in groups):
            groups = []
        subject = claims["sub"]
        if not isinstance(subject, str) or not subject:
            return _denied()
        return {
            "isAuthorized": True,
            "context": {"sub": subject, "groups": json.dumps(groups, separators=(",", ":"))},
        }
    except (KeyError, ValueError, jwt.PyJWTError, OSError, TypeError):
        return _denied()
