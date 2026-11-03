"""Private REST endpoint: resolve OU ID/name and return only JWT-authorized descendant accounts.

Browser calls the existing per-account policy endpoint for each returned account; this
keeps each DescribeEffectivePolicy request bounded and separately authorized.
"""
import json
import os
import re

import boto3
from botocore.exceptions import BotoCoreError, ClientError

from org_core import accounts_under_ou, describe_ou, find_ous_by_name
from policy_core import allowed_for_account
from policy_api import _response


def _client():
    role_arn = os.environ["ORG_DISCOVERY_ROLE_ARN"]
    if not re.fullmatch(r"arn:aws(?:-[a-z]+)?:iam::[0-9]{12}:role/[A-Za-z0-9_+=,.@/-]+", role_arn):
        raise ValueError("INVALID_ROLE_CONFIG")
    credentials = boto3.client("sts").assume_role(
        RoleArn=role_arn, RoleSessionName="aws-tag-extension-ou-discovery"
    )["Credentials"]
    return boto3.client(
        "organizations", region_name="us-east-1",
        aws_access_key_id=credentials["AccessKeyId"],
        aws_secret_access_key=credentials["SecretAccessKey"],
        aws_session_token=credentials["SessionToken"],
    )


def lambda_handler(event, context):
    try:
        identity = (event.get("requestContext") or {}).get("authorizer") or {}
        sub = identity.get("sub")
        groups = json.loads(identity.get("groups", "[]"))
        config = json.loads(os.environ["ACCOUNT_AUTHZ_JSON"])
        if not sub or not isinstance(groups, list) or not all(isinstance(g, str) for g in groups) or not isinstance(config, dict):
            return _response(403, {"error": "ACCOUNT_ACCESS_DENIED"})
    except (KeyError, ValueError, TypeError):
        return _response(500, {"error": "SERVER_CONFIG_ERROR"})

    query = event.get("queryStringParameters") or {}
    ou_id, ou_name = query.get("ouId"), query.get("ouName")
    if bool(ou_id) == bool(ou_name):
        return _response(400, {"error": "INVALID_OU_SELECTOR"})

    try:
        org = _client()
        if ou_id:
            choices = [describe_ou(org, ou_id)]
        else:
            choices = find_ous_by_name(org, ou_name)
        # Do not leak OU names, paths, or account membership without authorization.
        accessible = []
        for ou in choices:
            accounts = [item for item in accounts_under_ou(org, ou["id"])
                        if allowed_for_account(config, item["accountId"], sub, groups)]
            if accounts:
                accessible.append((ou, accounts))
        if not accessible:
            return _response(404, {"error": "OU_NOT_FOUND_OR_NOT_AUTHORIZED"})
        if len(accessible) > 1:
            return _response(409, {"error": "OU_NAME_AMBIGUOUS", "matches": [ou for ou, _ in accessible]})
        ou, accounts = accessible[0]
        return _response(200, {"ou": ou, "accounts": accounts})
    except ValueError as err:
        code = str(err)
        return _response(400 if code == "INVALID_OU_SELECTOR" else 413,
                         {"error": code if code in ("INVALID_OU_SELECTOR", "OU_DISCOVERY_LIMIT") else "INVALID_OU_SELECTOR"})
    except ClientError as err:
        code = err.response.get("Error", {}).get("Code", "")
        if code in ("OrganizationalUnitNotFoundException", "ParentNotFoundException"):
            return _response(404, {"error": "OU_NOT_FOUND_OR_NOT_AUTHORIZED"})
        return _response(502, {"error": "OU_DISCOVERY_UNAVAILABLE"})
    except (BotoCoreError, KeyError, TypeError):
        return _response(502, {"error": "OU_DISCOVERY_UNAVAILABLE"})
