import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from policy_core import normalize_policy, allowed_for_account


class PolicyCoreTests(unittest.TestCase):
    def test_normalization_modes_and_case(self):
        policy = {"tags": {
            "environment": {"tag_key": "Environment", "tag_value": ["dev", "prod"]},
            "blocked": {"tag_key": "Blocked", "tag_value": []},
            "costcenter": {"tag_key": "CostCenter"},
        }}
        tags = normalize_policy(json.dumps(policy))
        self.assertEqual([t["key"] for t in tags], ["Blocked", "CostCenter", "Environment"])
        self.assertEqual([t["valueMode"] for t in tags], ["deny", "any", "allowed"])

    def test_invalid_policy(self):
        with self.assertRaises(ValueError):
            normalize_policy('{"tags":[]}')

    def test_account_authz_denies_by_default(self):
        config = {"111122223333": {"roleArn": "example", "subjects": [], "groups": ["security"]}}
        self.assertFalse(allowed_for_account(config, "999988887777", "x", ["security"]))
        self.assertFalse(allowed_for_account(config, "111122223333", "x", ["developer"]))
        self.assertFalse(allowed_for_account(config, "../../etc", "x", ["security"]))
        self.assertTrue(allowed_for_account(config, "111122223333", "x", ["security"]))


if __name__ == "__main__":
    unittest.main()
