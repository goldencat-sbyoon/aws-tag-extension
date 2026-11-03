"""Pure policy normalization and authorization helpers."""
import json
import re

ACCOUNT_ID = re.compile(r"^[0-9]{12}$")


def normalize_policy(policy_content):
    policy = json.loads(policy_content) if isinstance(policy_content, str) else policy_content
    if not isinstance(policy, dict) or not isinstance(policy.get("tags", {}), dict):
        raise ValueError("Invalid effective tag policy")

    output = []
    for policy_key, rule in policy.get("tags", {}).items():
        if not isinstance(rule, dict):
            continue
        # Effective policy is already merged: values are plain strings/lists, not @@assign objects.
        key = rule.get("tag_key", str(policy_key).lower())
        if not isinstance(key, str) or not key:
            continue
        raw_values = rule.get("tag_value")
        if "tag_value" not in rule:
            mode, values = "any", []
        elif isinstance(raw_values, list) and len(raw_values) == 0:
            mode, values = "deny", []
        elif isinstance(raw_values, list) and all(isinstance(v, str) for v in raw_values):
            mode, values = "allowed", raw_values
        else:
            raise ValueError("Invalid tag_value in effective policy")

        output.append({
            "key": key,
            "valueMode": mode,
            "values": values,
            "enforcedFor": rule.get("enforced_for", []),
        })
    return sorted(output, key=lambda t: t["key"].casefold())


def allowed_for_account(config, account_id, subject, groups):
    if not ACCOUNT_ID.fullmatch(account_id):
        return False
    entry = config.get(account_id)
    if not isinstance(entry, dict):
        return False
    allowed_subjects = entry.get("subjects", [])
    allowed_groups = entry.get("groups", [])
    return bool((subject and subject in allowed_subjects) or set(groups).intersection(allowed_groups))
