import json
import os
import sys
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import jwt
from cryptography.hazmat.primitives.asymmetric import rsa
import authorizer
import policy_api


class AuthorizerTests(unittest.TestCase):
    method_arn = "arn:aws:execute-api:ap-northeast-2:000000000000:abc123/prod/GET/v1/accounts/111122223333/tag-policy"
    @classmethod
    def setUpClass(cls):
        cls.private = rsa.generate_private_key(public_exponent=65537, key_size=2048)

    def make_token(self, scope="tag-policy:read", algorithm="RS256"):
        payload = {"iss": "https://auth.company.example", "aud": "tag-api", "sub": "alice",
                   "iat": int(time.time()), "exp": int(time.time()) + 300, "scope": scope,
                   "groups": ["security"]}
        return jwt.encode(payload, self.private, algorithm=algorithm)

    def test_valid_scope_and_signature(self):
        signing = SimpleNamespace(key=self.private.public_key())
        with patch.dict(os.environ, {"AUTH_ISSUER": "https://auth.company.example",
                                     "AUTH_AUDIENCE": "tag-api",
                                     "AUTH_JWKS_URL": "https://auth.company.example/jwks"}):
            with patch.object(authorizer, "_jwks_client", SimpleNamespace(get_signing_key_from_jwt=lambda _: signing)):
                event = {"authorizationToken": "Bearer " + self.make_token(), "methodArn": self.method_arn}
                result = authorizer.lambda_handler(event, None)
                self.assertEqual(result["policyDocument"]["Statement"][0]["Effect"], "Allow")
                self.assertEqual(result["policyDocument"]["Statement"][0]["Resource"], self.method_arn)
                self.assertEqual(result["principalId"], "alice")
                self.assertEqual(json.loads(result["context"]["groups"]), ["security"])
                event["authorizationToken"] = "Bearer " + self.make_token(scope="unrelated")
                self.assertEqual(authorizer.lambda_handler(event, None)["policyDocument"]["Statement"][0]["Effect"], "Deny")

    def test_missing_bearer_denied(self):
        result = authorizer.lambda_handler({"methodArn": self.method_arn}, None)
        self.assertEqual(result["policyDocument"]["Statement"][0]["Effect"], "Deny")

    def test_invalid_method_arn_denied(self):
        result = authorizer.lambda_handler({"authorizationToken": "Bearer foo", "methodArn": "invalid"}, None)
        self.assertEqual(result["policyDocument"]["Statement"][0]["Resource"], "*")


class PolicyApiTests(unittest.TestCase):
    def setUp(self):
        self.config = {"111122223333": {"roleArn": "arn:aws:iam::111122223333:role/TagPolicyReadRole",
                                           "subjects": ["alice"], "groups": []}}
        self.event = {"requestContext": {"authorizer": {"sub": "alice", "groups": "[]"}},
                      "pathParameters": {"accountId": "111122223333"}}

    def test_denies_unmapped_account(self):
        self.event["pathParameters"]["accountId"] = "999988887777"
        with patch.dict(os.environ, {"ACCOUNT_AUTHZ_JSON": json.dumps(self.config)}):
            self.assertEqual(policy_api.lambda_handler(self.event, None)["statusCode"], 403)

    def test_returns_normalized_policy(self):
        class StubClient:
            def assume_role(self, **kwargs):
                return {"Credentials": {"AccessKeyId": "x", "SecretAccessKey": "y", "SessionToken": "z"}}

            def describe_effective_policy(self, **kwargs):
                self.policy_type = kwargs["PolicyType"]
                return {"EffectivePolicy": {"PolicyContent": json.dumps({"tags": {
                    "environment": {"tag_key": "Environment", "tag_value": ["dev", "prod"]}}})}}

        stub = StubClient()
        with patch.dict(os.environ, {"ACCOUNT_AUTHZ_JSON": json.dumps(self.config)}):
            with patch.object(policy_api.boto3, "client", return_value=stub):
                result = policy_api.lambda_handler(self.event, None)
        self.assertEqual(result["statusCode"], 200)
        body = json.loads(result["body"])
        self.assertEqual(body["accountId"], "111122223333")
        self.assertEqual(body["tagKeys"][0]["key"], "Environment")
        self.assertEqual(stub.policy_type, "TAG_POLICY")


if __name__ == "__main__":
    unittest.main()
