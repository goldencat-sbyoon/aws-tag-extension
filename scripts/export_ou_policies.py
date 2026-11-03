"""Export an OU's descendant accounts' final Effective TAG_POLICY as an offline bundle.

Run with management-account AWS credentials; no credentials are included in output.
"""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import sys

import boto3
from botocore.exceptions import ClientError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from org_core import accounts_under_ou, describe_ou, find_ous_by_name
from policy_core import normalize_policy


def make_bundle(client, *, ou_id=None, ou_name=None):
    if bool(ou_id) == bool(ou_name):
        raise ValueError("Specify exactly one OU ID or OU name")
    if ou_id:
        ou = describe_ou(client, ou_id)
    else:
        matches = find_ous_by_name(client, ou_name)
        if not matches:
            raise ValueError("OU not found")
        if len(matches) != 1:
            raise ValueError("Ambiguous OU name; use an OU ID: " +
                             ", ".join(f"{item['path']} ({item['id']})" for item in matches))
        ou = matches[0]
    accounts = []
    for item in accounts_under_ou(client, ou["id"]):
        account_id = item["accountId"]
        try:
            effective = client.describe_effective_policy(
                PolicyType="TAG_POLICY", TargetId=account_id)["EffectivePolicy"]
            keys = normalize_policy(effective["PolicyContent"])
            updated = effective.get("LastUpdatedTimestamp")
            record = {**item, "policyStatus": "ok", "tagKeys": keys,
                      "policyUpdatedAt": updated.isoformat() if updated else None}
        except ClientError as error:
            code = error.response.get("Error", {}).get("Code", "")
            if code not in ("EffectivePolicyNotFoundException", "PolicyTypeNotEnabledException"):
                raise  # Never produce a misleading, silently incomplete export.
            record = {**item, "policyStatus": "not_found", "tagKeys": [], "policyUpdatedAt": None}
        accounts.append(record)
    return {"bundleType": "aws-tag-extension-ou-effective-policy-v1", "policyType": "TAG_POLICY",
            "ou": ou, "generatedAt": datetime.now(timezone.utc).isoformat(), "accounts": accounts}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    selector = parser.add_mutually_exclusive_group(required=True)
    selector.add_argument("--ou-id")
    selector.add_argument("--ou-name")
    parser.add_argument("--output", required=True, help="Output JSON path")
    parser.add_argument("--profile", help="AWS profile (optional)")
    args = parser.parse_args()
    session = boto3.Session(profile_name=args.profile) if args.profile else boto3.Session()
    bundle = make_bundle(session.client("organizations", region_name="us-east-1"),
                         ou_id=args.ou_id, ou_name=args.ou_name)
    target = Path(args.output)
    target.write_text(json.dumps(bundle, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Exported {len(bundle['accounts'])} accounts into {target}")


if __name__ == "__main__":
    main()
