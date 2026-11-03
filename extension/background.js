/* Shared background entry for Chromium service workers and Firefox event pages. */
const TOKEN_KEY = "authSession";
const ACCOUNT_KEY = "accountByTab";
const MODE_KEY = "sourceModeByTab";
const MANUAL_KEY = "manualPoliciesByAccount";
const OU_BUNDLE_TYPE = "aws-tag-extension-ou-effective-policy-v1";
const MAX_BUNDLE_BYTES = 2_097_152;
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

async function fetchOuPolicies(ouId, ouName) {
  if (typeof ouId !== "string" || typeof ouName !== "string" || (!!ouId === !!ouName)) {
    throw new Error("INVALID_OU_SELECTOR");
  }
  if (ouId && !/^ou-[a-z0-9]{4,32}-[a-z0-9]{8,32}$/.test(ouId)) throw new Error("INVALID_OU_SELECTOR");
  if (ouName && (ouName.length > 128 || !ouName.trim())) throw new Error("INVALID_OU_SELECTOR");
  const session = await getSession();
  if (!session) throw new Error("LOGIN_REQUIRED");
  const config = await getConfig();
  const query = new URLSearchParams(ouId ? { ouId } : { ouName: ouName.trim() });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  let response;
  try {
    response = await fetch(`${config.apiBaseUrl}/v1/organizational-units/accounts?${query}`, {
      headers: { Authorization: `Bearer ${session.token}` }, cache: "no-store",
      credentials: "omit", signal: controller.signal
    });
  } catch {
    throw new Error(controller.signal.aborted ? "API_TIMEOUT" : "PRIVATE_API_UNREACHABLE");
  } finally { clearTimeout(timeout); }
  const body = await response.json().catch(() => null);
  if (response.status === 401) {
    await extensionApi().storage.session.remove(TOKEN_KEY);
    cachedPolicies.clear();
    throw new Error("LOGIN_REQUIRED");
  }
  if (response.status === 409 && body?.error === "OU_NAME_AMBIGUOUS" && Array.isArray(body.matches)) {
    return { ambiguous: true, matches: body.matches };
  }
  if (response.status === 404 && body?.error === "OU_NOT_FOUND_OR_NOT_AUTHORIZED") {
    throw new Error("OU_NOT_FOUND_OR_NOT_AUTHORIZED");
  }
  if (response.status === 400 && body?.error === "INVALID_OU_SELECTOR") throw new Error("INVALID_OU_SELECTOR");
  if (response.status === 413 && body?.error === "OU_DISCOVERY_LIMIT") throw new Error("OU_DISCOVERY_LIMIT");
  if (response.status === 403) throw new Error("API_GATEWAY_FORBIDDEN");
  if (!response.ok) throw new Error("OU_DISCOVERY_UNAVAILABLE");
  if (!body?.ou || !Array.isArray(body.accounts) ||
      body.accounts.some(item => !/^[0-9]{12}$/.test(item.accountId))) {
    throw new Error("INVALID_POLICY_RESPONSE");
  }
  // Each account is fetched via the existing JWT/allowlist-protected per-account endpoint.
  // Use bounded concurrency to avoid a large OU flooding Organizations/STS.
  const results = new Array(body.accounts.length);
  let cursor = 0;
  async function worker() {
    while (cursor < body.accounts.length) {
      const i = cursor++;
      const account = body.accounts[i];
      let policy;
      try { policy = await fetchPolicy(account.accountId); }
      catch (error) {
        if (error.message !== "TAG_POLICY_NOT_FOUND") throw error;
        policy = { accountId: account.accountId, tagKeys: [], policyStatus: "not_found" };
      }
      results[i] = { accountId: account.accountId, accountName: account.accountName,
        tagKeyCount: policy.tagKeys.length, policyStatus: policy.policyStatus || "ok" };
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, results.length) }, () => worker()));
  return { ou: body.ou, accounts: results };
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

async function clearAccountUnlessIn(tabId, accounts) {
  const selected = await getSelectedAccount(tabId);
  if (!selected || accounts.some(item => item.accountId === selected)) return;
  const data = await extensionApi().storage.session.get(ACCOUNT_KEY);
  const mapping = data[ACCOUNT_KEY] || {};
  delete mapping[String(tabId)];
  await extensionApi().storage.session.set({ [ACCOUNT_KEY]: mapping });
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

function normalizeOuBundle(content) {
  if (typeof content !== "string" || new TextEncoder().encode(content).length > MAX_BUNDLE_BYTES) {
    throw new Error("POLICY_FILE_TOO_LARGE");
  }
  let document;
  try { document = JSON.parse(content); } catch { throw new Error("INVALID_POLICY_JSON"); }
  if (document?.bundleType !== OU_BUNDLE_TYPE || document.policyType !== "TAG_POLICY" ||
      !/^ou-[a-z0-9]{4,32}-[a-z0-9]{8,32}$/.test(document.ou?.id) ||
      !Array.isArray(document.accounts) || document.accounts.length > 10_000) {
    throw new Error("INVALID_OU_BUNDLE");
  }
  const result = Object.create(null);
  const accounts = [];
  for (const entry of document.accounts) {
    if (!/^[0-9]{12}$/.test(entry?.accountId) || result[entry.accountId] ||
        !Array.isArray(entry.tagKeys) ||
        ![undefined, "ok", "not_found"].includes(entry.policyStatus) ||
        (entry.policyStatus === "not_found" && entry.tagKeys.length)) {
      throw new Error("INVALID_OU_BUNDLE");
    }
    // Use the exact same schema validation as a standalone policy file.
    const policy = normalizeImportedPolicy(JSON.stringify(entry), entry.accountId);
    policy.ouId = document.ou.id;
    policy.accountName = typeof entry.accountName === "string" ? entry.accountName.slice(0, 128) : "";
    policy.policyStatus = entry.policyStatus || "ok";
    result[entry.accountId] = policy;
    accounts.push({ accountId: entry.accountId, accountName: policy.accountName,
      tagKeyCount: policy.tagKeys.length, policyStatus: policy.policyStatus });
  }
  return { policies: result, accounts, ou: { id: document.ou.id,
    name: typeof document.ou.name === "string" ? document.ou.name.slice(0, 128) : "" } };
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
        const manualAccounts = Object.entries(localData[MANUAL_KEY] || {}).map(([id, policy]) =>
          ({ accountId: id, accountName: policy.accountName || "", tagKeyCount: policy.tagKeys.length }));
        return { authenticated: !!session, expiresAt: session?.expiresAt || null,
          accountId, mode, manualImported: !!localData[MANUAL_KEY]?.[accountId], manualAccounts };
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
        if (tabId === null) throw new Error("OPEN_EC2_CONSOLE_FIRST");
        if (typeof message.content !== "string") throw new Error("INVALID_POLICY_JSON");
        if (new TextEncoder().encode(message.content).length > MAX_BUNDLE_BYTES) throw new Error("POLICY_FILE_TOO_LARGE");
        let document;
        try { document = JSON.parse(message.content); } catch { throw new Error("INVALID_POLICY_JSON"); }
        if (document?.bundleType !== undefined) {
          const bundle = normalizeOuBundle(message.content);
          const data = await extensionApi().storage.local.get(MANUAL_KEY);
          await extensionApi().storage.local.set({ [MANUAL_KEY]:
            { ...(data[MANUAL_KEY] || {}), ...bundle.policies } });
          await setMode(tabId, "file");
          await clearAccountUnlessIn(tabId, bundle.accounts);
          return { ou: bundle.ou, accounts: bundle.accounts,
            accountCount: bundle.accounts.length };
        }
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
      case "GET_OU_POLICIES": {
        if (sender.id !== extensionApi().runtime.id || sender.tab) throw new Error("UNTRUSTED_SENDER");
        const tabId = await resolveEc2Tab(sender, message);
        if (tabId === null) throw new Error("OPEN_EC2_CONSOLE_FIRST");
        if (await getMode(tabId) !== "server") throw new Error("FILE_MODE_ACTIVE");
        const result = await fetchOuPolicies(message.ouId || "", message.ouName || "");
        if (!result.ambiguous) await clearAccountUnlessIn(tabId, result.accounts);
        return result;
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
