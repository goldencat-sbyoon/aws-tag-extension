import importlib.util
import json
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

PROJECT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT / "backend"))
from org_core import accounts_under_ou, find_ous_by_name
import ou_api

spec = importlib.util.spec_from_file_location("export_ou_policies", PROJECT / "scripts" / "export_ou_policies.py")
exporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exporter)

OU_A = "ou-abcd-12345678"
OU_B = "ou-abcd-87654321"
OU_CHILD = "ou-abcd-12341234"


class OrganizationsStub:
    def list_roots(self, **kwargs):
        return {"Roots": [{"Id": "r-abcd", "Name": "Root"}]}

    def list_organizational_units_for_parent(self, ParentId, **kwargs):
        return {"OrganizationalUnits": {
            "r-abcd": [{"Id": OU_A, "Name": "Production"}, {"Id": OU_B, "Name": "Production"}],
            OU_A: [{"Id": OU_CHILD, "Name": "Applications"}],
        }.get(ParentId, [])}

    def describe_organizational_unit(self, OrganizationalUnitId):
        return {"OrganizationalUnit": {"Id": OrganizationalUnitId, "Name": "Production"}}

    def list_accounts_for_parent(self, ParentId, **kwargs):
        return {"Accounts": {
            OU_A: [{"Id": "111122223333", "Name": "Billing", "State": "ACTIVE"}],
            OU_CHILD: [{"Id": "444455556666", "Name": "App", "State": "ACTIVE"}],
            OU_B: [{"Id": "999900001111", "Name": "Second", "State": "ACTIVE"},
                   {"Id": "888899990000", "Name": "Old", "State": "SUSPENDED"}],
        }.get(ParentId, [])}

    def describe_effective_policy(self, PolicyType, TargetId):
        if TargetId == "444455556666":
            from botocore.exceptions import ClientError
            raise ClientError({"Error": {"Code": "EffectivePolicyNotFoundException", "Message": "not found"}},
                              "DescribeEffectivePolicy")
        return {"EffectivePolicy": {"PolicyContent": json.dumps({"tags": {
            "environment": {"tag_key": "Environment", "tag_value": ["prod"]}}})}}


class OUDiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.org = OrganizationsStub()
        self.config = {"111122223333": {"subjects": ["alice"]},
                       "444455556666": {"subjects": ["alice"]},
                       "999900001111": {"subjects": ["alice"]}}
        self.event = {"requestContext": {"authorizer": {"sub": "alice", "groups": "[]"}},
                      "queryStringParameters": {"ouId": OU_A}}

    def call(self):
        with patch.dict(os.environ, {"ACCOUNT_AUTHZ_JSON": json.dumps(self.config)}):
            with patch.object(ou_api, "_client", return_value=self.org):
                return ou_api.lambda_handler(self.event, None)

    def test_nested_ou_accounts_and_suspended_exclusion(self):
        found = accounts_under_ou(self.org, OU_A)
        self.assertEqual([a["accountId"] for a in found], ["111122223333", "444455556666"])
        self.assertEqual(len(accounts_under_ou(self.org, OU_B)), 1)

    def test_account_pagination_is_exhausted_not_silently_truncated(self):
        class PaginatedStub(OrganizationsStub):
            def list_accounts_for_parent(self, ParentId, NextToken=None):
                if ParentId != OU_A:
                    return super().list_accounts_for_parent(ParentId)
                if not NextToken:
                    return {"Accounts": [{"Id": "111122223333", "Name": "First", "State": "ACTIVE"}],
                            "NextToken": "next-page"}
                return {"Accounts": [{"Id": "222233334444", "Name": "Second", "State": "ACTIVE"}]}

        found = accounts_under_ou(PaginatedStub(), OU_A)
        self.assertEqual([item["accountId"] for item in found],
                         ["111122223333", "222233334444", "444455556666"])

    def test_name_search_reports_duplicate_paths(self):
        found = find_ous_by_name(self.org, "production")
        self.assertEqual(len(found), 2)
        self.assertEqual(found[0]["path"], "Root/Production")

    def test_api_filters_unauthorized_accounts(self):
        self.config.pop("444455556666")
        response = self.call()
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual([a["accountId"] for a in json.loads(response["body"])["accounts"]],
                         ["111122223333"])

    def test_name_collision_only_exposes_authorized_matches(self):
        self.event["queryStringParameters"] = {"ouName": "Production"}
        self.assertEqual(self.call()["statusCode"], 409)
        self.config.pop("999900001111")
        single = self.call()
        self.assertEqual(single["statusCode"], 200)
        self.assertEqual(json.loads(single["body"])["ou"]["id"], OU_A)
        self.config.clear()
        self.assertEqual(self.call()["statusCode"], 404)

    def test_export_bundle_has_effective_policy_for_each_active_account(self):
        bundle = exporter.make_bundle(self.org, ou_id=OU_A)
        self.assertEqual(bundle["policyType"], "TAG_POLICY")
        self.assertEqual(len(bundle["accounts"]), 2)
        self.assertEqual(bundle["accounts"][0]["tagKeys"][0]["key"], "Environment")
        self.assertEqual(bundle["accounts"][1]["policyStatus"], "not_found")
        with self.assertRaisesRegex(ValueError, "Ambiguous"):
            exporter.make_bundle(self.org, ou_name="Production")


if __name__ == "__main__":
    unittest.main()
