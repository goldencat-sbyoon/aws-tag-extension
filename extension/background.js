/* Shared background entry for Chromium service workers and Firefox event pages. */
const TOKEN_KEY = "authSession";
const ACCOUNT_KEY = "accountByTab";
const MODE_KEY = "sourceModeByTab";
const MANUAL_KEY = "manualPoliciesByAccount";
const cachedPolicies = new Map();
const EC2_URL = /^https:\/\/(?:[a-z0-9-]+\.)?console\.aws\.amazon\.com\/ec2\//;

function extensionApi() {
  return globalThis.browser || globalThis.chrome;
}

async function getConfig() {
  const result = await fetch(extensionApi().runtime.getURL("config.json"));
  if (!result.ok) throw new Error("CONFIG_UNAVAILABLE");
  return result.json();
}

async function getSession() {
  const result = await extensionApi().storage.session.get(TOKEN_KEY);
  const session = result?.[TOKEN_KEY];
  if (!session || !Number.isFinite(session.expiresAt) || session.expiresAt <= Date.now() + 15_000) {
    return null;
  }
  return session;
}

async function authenticate(username, password) {
  if (typeof username !== "string" || typeof password !== "string" || !username || !password) {
    throw new Error("MISSING_CREDENTIALS");
  }
  const config = await getConfig();
  // Integration adapter: change request/response mapping for the actual corporate login API.
  const response = await fetch(config.loginUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
    cache: "no-store",
    credentials: "omit"
  });
  if (!response.ok) throw new Error("LOGIN_FAILED");
  const body = await response.json();
  const token = body.access_token;
  if (typeof token !== "string" || token.length < 10 || token.length > 8192) {
    throw new Error("INVALID_LOGIN_RESPONSE");
  }
  // Expiration is only used for local UX. Actual JWT validation occurs on the server.
  const segments = token.split(".");
  if (segments.length !== 3) throw new Error("INVALID_LOGIN_RESPONSE");
  const base64 = segments[1].replace(/-/g, "+").replace(/_/g, "/");
  const claims = JSON.parse(atob(base64));
  const expiresAt = Number(claims.exp) * 1000;
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now() + 30_000) {
    throw new Error("INVALID_TOKEN_EXPIRATION");
  }
  await extensionApi().storage.session.set({ [TOKEN_KEY]: { token, expiresAt } });
  cachedPolicies.clear();
  return { authenticated: true, expiresAt };
}

async function fetchPolicy(accountId, forceRefresh = false) {
  if (!/^[0-9]{12}$/.test(accountId)) throw new Error("INVALID_ACCOUNT_ID");
  const session = await getSession();
  if (!session) throw new Error("LOGIN_REQUIRED");
  const cached = cachedPolicies.get(accountId);
  if (!forceRefresh && cached && Date.now() - cached.timestamp < 300_000) return cached.data;
  const config = await getConfig();
  const url = `${config.apiBaseUrl}/v1/accounts/${accountId}/tag-policy`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${session.token}` },
      cache: "no-store",
      credentials: "omit",
      signal: controller.signal
    });
  } catch (error) {
    if (controller.signal.aborted) throw new Error("API_TIMEOUT");
    // DNS, VPN routing, TLS and VPCE security group failures all surface as network errors.
    throw new Error("PRIVATE_API_UNREACHABLE");
  } finally {
    clearTimeout(timeout);
  }
  const body = await response.json().catch(() => null);
  if (response.status === 401) {
    await extensionApi().storage.session.remove(TOKEN_KEY);
    cachedPolicies.clear();
    throw new Error("LOGIN_REQUIRED");
  }
  if (response.status === 403) {
    if (body?.error === "ACCOUNT_ACCESS_DENIED") throw new Error("ACCOUNT_ACCESS_DENIED");
    throw new Error("API_GATEWAY_FORBIDDEN");
  }
  if (response.status === 404) {
    throw new Error(body?.error === "TAG_POLICY_NOT_FOUND" ? "TAG_POLICY_NOT_FOUND" : "API_ROUTE_NOT_FOUND");
  }
  if (!response.ok) throw new Error("POLICY_UNAVAILABLE");
  const data = body;
  if (!data || data.accountId !== accountId || !Array.isArray(data.tagKeys)) {
    throw new Error("INVALID_POLICY_RESPONSE");
  }
  cachedPolicies.set(accountId, { timestamp: Date.now(), data });
  return data;
}

async function resolveEc2Tab(sender, message) {
  if (sender.tab?.id !== undefined) {
    return EC2_URL.test(sender.url || "") ? sender.tab.id : null;
  }
  const tabId = sender.tab?.id ?? message.tabId;
  if (!Number.isInteger(tabId) || tabId < 0) return null;
  const tab = await extensionApi().tabs.get(tabId);
  return EC2_URL.test(tab.url || "") ? tabId : null;
}

async function getSelectedAccount(tabId) {
  if (tabId === null) return null;
  const data = await extensionApi().storage.session.get(ACCOUNT_KEY);
  return data[ACCOUNT_KEY]?.[String(tabId)] || null;
}

async function getMode(tabId) {
  if (tabId === null) return "server";
  const data = await extensionApi().storage.session.get(MODE_KEY);
  return data[MODE_KEY]?.[String(tabId)] === "file" ? "file" : "server";
}

async function setMode(tabId, mode) {
  if (tabId === null) throw new Error("OPEN_EC2_CONSOLE_FIRST");
  if (!["server", "file"].includes(mode)) throw new Error("INVALID_SOURCE_MODE");
  const data = await extensionApi().storage.session.get(MODE_KEY);
  const mapping = data[MODE_KEY] || {};
  mapping[String(tabId)] = mode;
  await extensionApi().storage.session.set({ [MODE_KEY]: mapping });
}

function normalizeImportedPolicy(content, accountId) {
  if (typeof content !== "string" || content.length > 131_072) throw new Error("POLICY_FILE_TOO_LARGE");
  let document;
  try { document = JSON.parse(content); } catch { throw new Error("INVALID_POLICY_JSON"); }
  if (!document || typeof document !== "object") throw new Error("INVALID_POLICY_JSON");
  if (document.EffectivePolicy && typeof document.EffectivePolicy === "object") {
    const effective = document.EffectivePolicy;
    if (effective.TargetId && effective.TargetId !== accountId) throw new Error("POLICY_ACCOUNT_MISMATCH");
    if (effective.PolicyType && effective.PolicyType !== "TAG_POLICY") throw new Error("REQUIRE_EFFECTIVE_POLICY");
    if (typeof effective.PolicyContent !== "string") throw new Error("INVALID_POLICY_JSON");
    try { document = JSON.parse(document.EffectivePolicy.PolicyContent); }
    catch { throw new Error("INVALID_POLICY_JSON"); }
  } else if (typeof document.PolicyContent === "string") {
    try { document = JSON.parse(document.PolicyContent); }
    catch { throw new Error("INVALID_POLICY_JSON"); }
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) throw new Error("INVALID_POLICY_JSON");
  if (document.accountId && document.accountId !== accountId) throw new Error("POLICY_ACCOUNT_MISMATCH");

  let keys;
  if (Array.isArray(document.tagKeys)) {
    keys = document.tagKeys;
  } else if (document.tags && typeof document.tags === "object" && !Array.isArray(document.tags)) {
    keys = Object.entries(document.tags).map(([policyKey, rule]) => {
      if (!rule || typeof rule !== "object" || Array.isArray(rule)) throw new Error("INVALID_POLICY_JSON");
      const key = rule.tag_key ?? policyKey.toLowerCase();
      if (typeof key !== "string" || !key) throw new Error("INVALID_POLICY_JSON");
      if (rule.tag_value !== undefined && !Array.isArray(rule.tag_value)) throw new Error("REQUIRE_EFFECTIVE_POLICY");
      const values = rule.tag_value ?? [];
      return { key, values, valueMode: rule.tag_value === undefined ? "any" : values.length ? "allowed" : "deny",
        enforcedFor: rule.enforced_for ?? [] };
    });
  } else {
    throw new Error("REQUIRE_EFFECTIVE_POLICY");
  }
  if (keys.length > 500 || keys.some(k => !k || typeof k.key !== "string" || !k.key ||
      !["any", "allowed", "deny"].includes(k.valueMode) || !Array.isArray(k.values) ||
      k.values.some(v => typeof v !== "string") ||
      (k.enforcedFor !== undefined && (!Array.isArray(k.enforcedFor) ||
        k.enforcedFor.some(v => typeof v !== "string"))))) {
    throw new Error("INVALID_POLICY_JSON");
  }
  const names = keys.map(k => k.key);
  if (new Set(names).size !== names.length) throw new Error("DUPLICATE_TAG_KEYS");
  return { accountId, tagKeys: keys.map(({ key, valueMode, values, enforcedFor }) =>
    ({ key, valueMode, values, enforcedFor: enforcedFor ?? [] })),
    importedAt: new Date().toISOString(), source: "file" };
}

async function getManualPolicy(accountId) {
  const data = await extensionApi().storage.local.get(MANUAL_KEY);
  const policy = data[MANUAL_KEY]?.[accountId];
  if (!policy) throw new Error("MANUAL_POLICY_NOT_IMPORTED");
  return policy;
}

extensionApi().runtime.onMessage.addListener((message, sender, respond) => {
  (async () => {
    if (!message || typeof message !== "object") throw new Error("INVALID_MESSAGE");
    switch (message.type) {
      case "LOGIN":
        // Never log credentials or echo them in the result.
        if (sender.id !== extensionApi().runtime.id) throw new Error("UNTRUSTED_SENDER");
        return authenticate(message.username, message.password);
      case "STATUS": {
        const session = await getSession();
        const tabId = await resolveEc2Tab(sender, message);
        const accountId = await getSelectedAccount(tabId);
        const mode = await getMode(tabId);
        const localData = await extensionApi().storage.local.get(MANUAL_KEY);
        return { authenticated: !!session, expiresAt: session?.expiresAt || null,
          accountId, mode, manualImported: !!localData[MANUAL_KEY]?.[accountId] };
      }
      case "SELECT_ACCOUNT": {
        if (!/^[0-9]{12}$/.test(message.accountId)) throw new Error("INVALID_ACCOUNT_ID");
        const tabId = await resolveEc2Tab(sender, message);
        if (tabId === null) throw new Error("OPEN_EC2_CONSOLE_FIRST");
        const data = await extensionApi().storage.session.get(ACCOUNT_KEY);
        const mapping = data[ACCOUNT_KEY] || {};
        mapping[String(tabId)] = message.accountId;
        await extensionApi().storage.session.set({ [ACCOUNT_KEY]: mapping });
        return { accountId: message.accountId };
      }
      case "SELECT_MODE": {
        if (sender.id !== extensionApi().runtime.id || sender.tab) throw new Error("UNTRUSTED_SENDER");
        const tabId = await resolveEc2Tab(sender, message);
        await setMode(tabId, message.mode);
        return { mode: message.mode };
      }
      case "IMPORT_POLICY": {
        if (sender.id !== extensionApi().runtime.id || sender.tab) throw new Error("UNTRUSTED_SENDER");
        const tabId = await resolveEc2Tab(sender, message);
        const accountId = await getSelectedAccount(tabId);
        if (!accountId) throw new Error("ACCOUNT_NOT_SELECTED");
        const policy = normalizeImportedPolicy(message.content, accountId);
        const data = await extensionApi().storage.local.get(MANUAL_KEY);
        const policies = data[MANUAL_KEY] || {};
        policies[accountId] = policy;
        await extensionApi().storage.local.set({ [MANUAL_KEY]: policies });
        await setMode(tabId, "file");
        return { accountId, tagKeyCount: policy.tagKeys.length, importedAt: policy.importedAt };
      }
      case "LOGOUT":
        await extensionApi().storage.session.remove(TOKEN_KEY);
        cachedPolicies.clear();
        return { authenticated: false };
      case "GET_POLICY":
        if (sender.id !== extensionApi().runtime.id) throw new Error("UNTRUSTED_SENDER");
        const tabId = await resolveEc2Tab(sender, message);
        if (tabId === null) throw new Error("UNTRUSTED_PAGE");
        if (message.accountId !== await getSelectedAccount(tabId)) throw new Error("ACCOUNT_NOT_SELECTED");
        if (await getMode(tabId) === "file") return getManualPolicy(message.accountId);
        return fetchPolicy(message.accountId);
      case "TEST_CONNECTION": {
        if (sender.id !== extensionApi().runtime.id || sender.tab) throw new Error("UNTRUSTED_SENDER");
        const diagnosticTabId = await resolveEc2Tab(sender, message);
        if (diagnosticTabId === null) throw new Error("OPEN_EC2_CONSOLE_FIRST");
        const selectedId = await getSelectedAccount(diagnosticTabId);
        if (!selectedId) throw new Error("ACCOUNT_NOT_SELECTED");
        if (await getMode(diagnosticTabId) === "file") throw new Error("FILE_MODE_ACTIVE");
        const result = await fetchPolicy(selectedId, true);
        return { accountId: selectedId, tagKeyCount: result.tagKeys.length };
      }
      default:
        throw new Error("UNKNOWN_MESSAGE");
    }
  })().then(data => respond({ ok: true, data }), error => respond({ ok: false, error: error.message || "UNKNOWN_ERROR" }));
  return true;
});
