"""OU discovery helpers; never mistake an OU attachment for an effective account policy."""

import re

OU_ID = re.compile(r"^ou-[a-z0-9]{4,32}-[a-z0-9]{8,32}$")
MAX_DISCOVERY = 10000  # Fail explicitly rather than silently truncate large organizations.


def _items(client, operation, key, **kwargs):
    next_token = None
    while True:
        args = dict(kwargs)
        if next_token:
            args["NextToken"] = next_token
        response = getattr(client, operation)(**args)
        for item in response.get(key, []):
            yield item
        next_token = response.get("NextToken")
        if not next_token:
            break


def find_ous_by_name(client, name):
    """Exact case-insensitive search across roots and descendants; show paths for collisions."""
    if not isinstance(name, str) or not name.strip() or len(name) > 128:
        raise ValueError("INVALID_OU_SELECTOR")
    wanted = name.strip().casefold()
    queue = [(root["Id"], root.get("Name", "Root"))
             for root in _items(client, "list_roots", "Roots")]
    found, traversed = [], 0
    while queue:
        parent_id, parent_path = queue.pop(0)
        for ou in _items(client, "list_organizational_units_for_parent",
                         "OrganizationalUnits", ParentId=parent_id):
            traversed += 1
            if traversed > MAX_DISCOVERY:
                raise ValueError("OU_DISCOVERY_LIMIT")
            path = parent_path + "/" + ou["Name"]
            if ou["Name"].casefold() == wanted:
                found.append({"id": ou["Id"], "name": ou["Name"], "path": path})
            queue.append((ou["Id"], path))
    return found


def describe_ou(client, ou_id):
    if not isinstance(ou_id, str) or not OU_ID.fullmatch(ou_id):
        raise ValueError("INVALID_OU_SELECTOR")
    ou = client.describe_organizational_unit(OrganizationalUnitId=ou_id)["OrganizationalUnit"]
    return {"id": ou["Id"], "name": ou["Name"]}


def accounts_under_ou(client, ou_id):
    """Traverse nested OUs, using AWS pagination and current account State."""
    if not OU_ID.fullmatch(ou_id):
        raise ValueError("INVALID_OU_SELECTOR")
    queue, visited, accounts = [ou_id], set(), []
    while queue:
        current = queue.pop(0)
        if current in visited:
            continue
        visited.add(current)
        if len(visited) > MAX_DISCOVERY:
            raise ValueError("OU_DISCOVERY_LIMIT")
        for account in _items(client, "list_accounts_for_parent", "Accounts", ParentId=current):
            if account.get("State", account.get("Status")) == "ACTIVE":
                accounts.append({"accountId": account["Id"], "accountName": account.get("Name", "")})
                if len(accounts) > MAX_DISCOVERY:
                    raise ValueError("OU_DISCOVERY_LIMIT")
        for child in _items(client, "list_organizational_units_for_parent",
                            "OrganizationalUnits", ParentId=current):
            queue.append(child["Id"])
    return sorted(accounts, key=lambda item: item["accountId"])
