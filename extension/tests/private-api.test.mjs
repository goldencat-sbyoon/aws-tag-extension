import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const code = await readFile(resolve(import.meta.dirname, "../background.js"), "utf8");
const accountId = "111122223333";
const apiBaseUrl = "https://private-api.company.example/prod";

function setup({ apiResponse = { status: 200, body: { accountId, tagKeys: [{ key: "Environment" }] } },
  ouResponse, accountResponses = {}, failNetwork = false } = {}) {
  const values = { authSession: { token: "test.jwt.token", expiresAt: Date.now() + 300_000 },
    accountByTab: { "10": accountId } };
  const localValues = {};
  const requests = [];
  let listener;
  const browser = {
    runtime: {
      id: "ext-test",
      getURL: () => "chrome-extension://ext-test/config.json",
      onMessage: { addListener: fn => { listener = fn; } }
    },
    storage: {
      session: {
        get: async key => ({ [key]: values[key] }),
        set: async changes => Object.assign(values, changes),
        remove: async key => { delete values[key]; }
      },
      local: {
        get: async key => ({ [key]: localValues[key] }),
        set: async changes => Object.assign(localValues, changes)
      }
    },
    tabs: { get: async () => ({ url: "https://console.aws.amazon.com/ec2/home" }) }
  };
  const fetch = async (url, options) => {
    if (url.startsWith("chrome-extension:")) return { ok: true, json: async () => ({ apiBaseUrl }) };
    requests.push({ url, options });
    if (failNetwork) throw new TypeError("Network failed");
    const id = url.match(/\/v1\/accounts\/(\d{12})\/tag-policy/)?.[1];
    const reply = url.includes("/v1/organizational-units/accounts?") ? (ouResponse || apiResponse) :
      accountResponses[id] || apiResponse;
    return { ok: reply.status >= 200 && reply.status < 300,
      status: reply.status, json: async () => reply.body };
  };
  vm.runInNewContext(code, { browser, fetch, AbortController, setTimeout, clearTimeout,
    Date, Map, TextEncoder, URLSearchParams });
  const send = (type, extra = {}) => new Promise(resolve => listener(
    { type, ...extra }, { id: "ext-test", url: "chrome-extension://ext-test/popup.html" }, resolve
  ));
  return { send, requests, values, localValues };
}

test("background calls Private REST API with JWT; connection test bypasses cache", async () => {
  const { send, requests } = setup();
  const first = await send("GET_POLICY", { accountId, tabId: 10 });
  assert.equal(first.ok, true);
  assert.equal(first.data.tagKeys.length, 1);
  await send("GET_POLICY", { accountId, tabId: 10 });
  assert.equal(requests.length, 1, "second normal call uses cache");
  const diagnostic = await send("TEST_CONNECTION", { tabId: 10 });
  assert.equal(diagnostic.data.tagKeyCount, 1);
  assert.equal(requests.length, 2, "diagnostic forces a network call");
  assert.equal(requests[0].url, `${apiBaseUrl}/v1/accounts/${accountId}/tag-policy`);
  assert.equal(requests[0].options.headers.Authorization, "Bearer test.jwt.token");
  assert.equal(requests[0].options.credentials, "omit");
});

test("network errors have a distinct error code", async () => {
  const { send } = setup({ failNetwork: true });
  assert.equal((await send("TEST_CONNECTION", { tabId: 10 })).error, "PRIVATE_API_UNREACHABLE");
});

test("Gateway 403 is distinguished from backend account 403", async () => {
  const gateway = setup({ apiResponse: { status: 403, body: { message: "Forbidden" } } });
  assert.equal((await gateway.send("TEST_CONNECTION", { tabId: 10 })).error, "API_GATEWAY_FORBIDDEN");
  const account = setup({ apiResponse: { status: 403, body: { error: "ACCOUNT_ACCESS_DENIED" } } });
  assert.equal((await account.send("TEST_CONNECTION", { tabId: 10 })).error, "ACCOUNT_ACCESS_DENIED");
});

test("unselected or mismatched account cannot be queried", async () => {
  const { send, requests } = setup();
  assert.equal((await send("GET_POLICY", { accountId: "222233334444", tabId: 10 })).error, "ACCOUNT_NOT_SELECTED");
  assert.equal(requests.length, 0);
});

test("manual Effective Policy works without JWT and makes no network request", async () => {
  const { send, requests, values } = setup();
  const policy = JSON.stringify({ tags: {
    environment: { tag_key: "Environment", tag_value: ["dev", "prod"] },
    costcenter: { tag_key: "CostCenter" }
  }});
  const imported = await send("IMPORT_POLICY", { tabId: 10, content: policy });
  assert.equal(imported.ok, true);
  assert.equal(imported.data.tagKeyCount, 2);
  delete values.authSession;
  const status = await send("STATUS", { tabId: 10 });
  assert.equal(status.data.authenticated, false);
  assert.equal(status.data.mode, "file");
  const fetched = await send("GET_POLICY", { accountId, tabId: 10 });
  assert.equal(fetched.ok, true);
  assert.equal(fetched.data.tagKeys.find(k => k.key === "CostCenter").valueMode, "any");
  assert.equal(requests.length, 0);
});

test("manual import rejects account mismatch and raw merge operators", async () => {
  const { send } = setup();
  const mismatch = await send("IMPORT_POLICY", { tabId: 10,
    content: JSON.stringify({ accountId: "222233334444", tagKeys: [] }) });
  assert.equal(mismatch.error, "POLICY_ACCOUNT_MISMATCH");
  const rawPolicy = await send("IMPORT_POLICY", { tabId: 10,
    content: JSON.stringify({ tags: { environment: {
      tag_key: { "@@assign": "Environment" }, tag_value: { "@@assign": ["prod"] }
    } } }) });
  assert.equal(rawPolicy.error, "INVALID_POLICY_JSON");
});

test("CLI EffectivePolicy wrapper verifies target account and policy type", async () => {
  const { send, requests } = setup();
  const effective = { tags: { environment: { tag_key: "Environment", tag_value: ["prod"] } } };
  const wrapped = { EffectivePolicy: { PolicyContent: JSON.stringify(effective), TargetId: accountId,
    PolicyType: "TAG_POLICY" } };
  const result = await send("IMPORT_POLICY", { tabId: 10, content: JSON.stringify(wrapped) });
  assert.equal(result.data.tagKeyCount, 1);
  assert.equal(requests.length, 0);
  wrapped.EffectivePolicy.TargetId = "222233334444";
  assert.equal((await send("IMPORT_POLICY", { tabId: 10, content: JSON.stringify(wrapped) })).error,
    "POLICY_ACCOUNT_MISMATCH");
  wrapped.EffectivePolicy.TargetId = accountId;
  wrapped.EffectivePolicy.PolicyType = "BACKUP_POLICY";
  assert.equal((await send("IMPORT_POLICY", { tabId: 10, content: JSON.stringify(wrapped) })).error,
    "REQUIRE_EFFECTIVE_POLICY");
});

test("OU server lookup retrieves every authorized descendant account's effective policy", async () => {
  const secondId = "444455556666";
  const ouId = "ou-abcd-12345678";
  const { send, requests } = setup({
    ouResponse: { status: 200, body: { ou: { id: ouId, name: "Production" }, accounts: [
      { accountId, accountName: "First" }, { accountId: secondId, accountName: "Second" }
    ] } },
    accountResponses: { [secondId]: { status: 200, body: { accountId: secondId,
      tagKeys: [{ key: "CostCenter", valueMode: "any", values: [] }] } } }
  });
  const response = await send("GET_OU_POLICIES", { tabId: 10, ouId, ouName: "" });
  assert.equal(response.ok, true);
  assert.equal(response.data.accounts.length, 2);
  assert.equal(requests.length, 3);
  assert.ok(requests.every(req => req.options.headers.Authorization === "Bearer test.jwt.token"));
  await send("SELECT_ACCOUNT", { tabId: 10, accountId: secondId });
  const cached = await send("GET_POLICY", { tabId: 10, accountId: secondId });
  assert.equal(cached.data.tagKeys[0].key, "CostCenter");
  assert.equal(requests.length, 3, "OU lookup populates existing account policy cache");
});

test("OU name collisions return choice list without fetching policies", async () => {
  const { send, requests } = setup({ ouResponse: { status: 409, body: {
    error: "OU_NAME_AMBIGUOUS", matches: [{ id: "ou-abcd-12345678", name: "Prod" }]
  } } });
  const answer = await send("GET_OU_POLICIES", { tabId: 10, ouId: "", ouName: "Prod" });
  assert.equal(answer.data.ambiguous, true);
  assert.equal(requests.length, 1);
});

test("offline OU bundle imports all accounts without JWT or API requests", async () => {
  const { send, requests, values, localValues } = setup();
  delete values.authSession;
  delete values.accountByTab;
  const bundle = { bundleType: "aws-tag-extension-ou-effective-policy-v1", policyType: "TAG_POLICY",
    ou: { id: "ou-abcd-12345678", name: "Production" }, accounts: [
      { accountId, accountName: "Billing", tagKeys: [{ key: "Environment", values: ["prod"], valueMode: "allowed" }] },
      { accountId: "444455556666", accountName: "App", tagKeys: [{ key: "CostCenter", values: [], valueMode: "any" }] }
    ] };
  const imported = await send("IMPORT_POLICY", { tabId: 10, content: JSON.stringify(bundle) });
  assert.equal(imported.ok, true);
  assert.equal(imported.data.accountCount, 2);
  assert.equal(Object.keys(localValues.manualPoliciesByAccount).length, 2);
  await send("SELECT_ACCOUNT", { accountId: "444455556666", tabId: 10 });
  const policy = await send("GET_POLICY", { accountId: "444455556666", tabId: 10 });
  assert.equal(policy.data.tagKeys[0].key, "CostCenter");
  assert.equal(requests.length, 0);
  bundle.accounts[1].accountId = accountId;
  const rejected = await send("IMPORT_POLICY", { tabId: 10, content: JSON.stringify(bundle) });
  assert.equal(rejected.error, "INVALID_OU_BUNDLE");
  assert.equal(Object.keys(localValues.manualPoliciesByAccount).length, 2);
});

test("OU policy lookup preserves empty policy and does not claim a failed account fetch succeeded", async () => {
  const secondId = "444455556666";
  const ouResponse = { status: 200, body: { ou: { id: "ou-abcd-12345678", name: "Prod" },
    accounts: [{ accountId }, { accountId: secondId }] } };
  const missing = setup({ ouResponse, accountResponses: {
    [secondId]: { status: 404, body: { error: "TAG_POLICY_NOT_FOUND" } }
  } });
  const success = await missing.send("GET_OU_POLICIES", { tabId: 10,
    ouId: "ou-abcd-12345678", ouName: "" });
  assert.equal(success.ok, true);
  assert.equal(success.data.accounts[1].policyStatus, "not_found");
  assert.equal(success.data.accounts[1].tagKeyCount, 0);

  const forbidden = setup({ ouResponse, accountResponses: {
    [secondId]: { status: 403, body: { error: "ACCOUNT_ACCESS_DENIED" } }
  } });
  const failure = await forbidden.send("GET_OU_POLICIES", { tabId: 10,
    ouId: "ou-abcd-12345678", ouName: "" });
  assert.equal(failure.ok, false);
  assert.equal(failure.error, "ACCOUNT_ACCESS_DENIED");
});
