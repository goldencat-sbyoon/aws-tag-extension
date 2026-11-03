/* Shared background entry for Chromium service workers and Firefox event pages. */
const TOKEN_KEY = "authSession";
const ACCOUNT_KEY = "accountByTab";
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

async function fetchPolicy(accountId) {
  if (!/^[0-9]{12}$/.test(accountId)) throw new Error("INVALID_ACCOUNT_ID");
  const session = await getSession();
  if (!session) throw new Error("LOGIN_REQUIRED");
  const cached = cachedPolicies.get(accountId);
  if (cached && Date.now() - cached.timestamp < 300_000) return cached.data;
  const config = await getConfig();
  const url = `${config.apiBaseUrl}/v1/accounts/${accountId}/tag-policy`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${session.token}` },
    cache: "no-store",
    credentials: "omit"
  });
  if (response.status === 401) {
    await extensionApi().storage.session.remove(TOKEN_KEY);
    throw new Error("LOGIN_REQUIRED");
  }
  if (response.status === 403) throw new Error("ACCOUNT_ACCESS_DENIED");
  if (response.status === 404) throw new Error("TAG_POLICY_NOT_FOUND");
  if (!response.ok) throw new Error("POLICY_UNAVAILABLE");
  const data = await response.json();
  if (data.accountId !== accountId || !Array.isArray(data.tagKeys)) {
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
        return { authenticated: !!session, expiresAt: session?.expiresAt || null,
          accountId: await getSelectedAccount(tabId) };
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
      case "LOGOUT":
        await extensionApi().storage.session.remove(TOKEN_KEY);
        cachedPolicies.clear();
        return { authenticated: false };
      case "GET_POLICY":
        if (sender.id !== extensionApi().runtime.id) throw new Error("UNTRUSTED_SENDER");
        const tabId = await resolveEc2Tab(sender, message);
        if (tabId === null) throw new Error("UNTRUSTED_PAGE");
        if (message.accountId !== await getSelectedAccount(tabId)) throw new Error("ACCOUNT_NOT_SELECTED");
        return fetchPolicy(message.accountId);
      default:
        throw new Error("UNKNOWN_MESSAGE");
    }
  })().then(data => respond({ ok: true, data }), error => respond({ ok: false, error: error.message || "UNKNOWN_ERROR" }));
  return true;
});
