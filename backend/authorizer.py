"""API Gateway REST API TOKEN Lambda Authorizer (IAM policy response)."""
import json
import os

import jwt
from jwt import PyJWKClient

_jwks_client = None


def _policy(effect, resource, principal="anonymous", auth_context=None):
    return {
        "principalId": principal,
        "policyDocument": {
            "Version": "2012-10-17",
            "Statement": [{"Action": "execute-api:Invoke", "Effect": effect, "Resource": resource}],
        },
        "context": auth_context or {},
    }


def lambda_handler(event, context):
    global _jwks_client
    # REST TOKEN authorizers receive authorizationToken and methodArn.
    method_arn = event.get("methodArn", "*")
    if not isinstance(method_arn, str) or not method_arn.startswith("arn:aws:execute-api:"):
        return _policy("Deny", "*")
    try:
        issuer = os.environ["AUTH_ISSUER"]
        audience = os.environ["AUTH_AUDIENCE"]
        jwks_url = os.environ["AUTH_JWKS_URL"]
        required_scope = os.environ.get("AUTH_REQUIRED_SCOPE", "tag-policy:read")
        if not issuer.startswith("https://") or not jwks_url.startswith("https://"):
            return _policy("Deny", method_arn)

        scheme, _, token = event.get("authorizationToken", "").partition(" ")
        if scheme.lower() != "bearer" or not token or len(token) > 8192:
            return _policy("Deny", method_arn)
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
            return _policy("Deny", method_arn)
        groups = claims.get("groups", [])
        if not isinstance(groups, list) or not all(isinstance(g, str) for g in groups):
            groups = []
        subject = claims["sub"]
        if not isinstance(subject, str) or not subject:
            return _policy("Deny", method_arn)
        return _policy("Allow", method_arn, subject, {
            "sub": subject, "groups": json.dumps(groups, separators=(",", ":")),
        })
    except (KeyError, ValueError, jwt.PyJWTError, OSError, TypeError):
        return _policy("Deny", method_arn)
