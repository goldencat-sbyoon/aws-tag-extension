"""Read effective tag policy in an authorized account using a configured role."""
import json
import os
import re

import boto3
from botocore.exceptions import BotoCoreError, ClientError

from policy_core import ACCOUNT_ID, allowed_for_account, normalize_policy


def _response(code, payload):
    return {
        "statusCode": code,
        "headers": {"content-type": "application/json", "cache-control": "no-store"},
        "body": json.dumps(payload, separators=(",", ":")),
    }


def lambda_handler(event, context):
    request_context = event.get("requestContext", {})
    # Fail closed: do not trust identity passed through headers or request body.
    # REST Lambda proxy integration flattens the custom authorizer context.
    identity = request_context.get("authorizer", {})
    sub = identity.get("sub")
    try:
        groups = json.loads(identity.get("groups", "[]"))
        config = json.loads(os.environ["ACCOUNT_AUTHZ_JSON"])
    except (ValueError, KeyError, TypeError):
        return _response(500, {"error": "SERVER_CONFIG_ERROR"})
    if not isinstance(groups, list) or not isinstance(config, dict):
        return _response(500, {"error": "SERVER_CONFIG_ERROR"})

    account_id = event.get("pathParameters", {}).get("accountId", "")
    if not isinstance(account_id, str) or not ACCOUNT_ID.fullmatch(account_id):
        return _response(400, {"error": "INVALID_ACCOUNT_ID"})
    if not allowed_for_account(config, account_id, sub, groups):
        return _response(403, {"error": "ACCOUNT_ACCESS_DENIED"})

    role_arn = config[account_id].get("roleArn", "")
    if not re.fullmatch(r"arn:aws(?:-[a-z]+)?:iam::" + re.escape(account_id) + r":role/[A-Za-z0-9_+=,.@/-]+", role_arn):
        return _response(500, {"error": "INVALID_ROLE_CONFIG"})

    try:
        credentials = boto3.client("sts").assume_role(
            RoleArn=role_arn, RoleSessionName="aws-tag-extension-read"
        )["Credentials"]
        org = boto3.client(
            "organizations", region_name="us-east-1",
            aws_access_key_id=credentials["AccessKeyId"],
            aws_secret_access_key=credentials["SecretAccessKey"],
            aws_session_token=credentials["SessionToken"],
        )
        effective = org.describe_effective_policy(PolicyType="TAG_POLICY")["EffectivePolicy"]
        return _response(200, {
            "accountId": account_id,
            "policyUpdatedAt": effective.get("LastUpdatedTimestamp").isoformat() if effective.get("LastUpdatedTimestamp") else None,
            "tagKeys": normalize_policy(effective["PolicyContent"]),
        })
    except ClientError as err:
        name = err.response.get("Error", {}).get("Code", "")
        if name in ("PolicyTypeNotEnabledException", "EffectivePolicyNotFoundException"):
            return _response(404, {"error": "TAG_POLICY_NOT_FOUND"})
        if name in ("AccessDeniedException", "AccessDenied"):
            return _response(502, {"error": "POLICY_ROLE_ACCESS_DENIED"})
        return _response(502, {"error": "AWS_POLICY_UNAVAILABLE"})
    except (BotoCoreError, ValueError, KeyError, TypeError):
        return _response(502, {"error": "AWS_POLICY_UNAVAILABLE"})
