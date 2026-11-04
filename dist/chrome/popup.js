const api = globalThis.browser || globalThis.chrome;
const loginForm = document.getElementById("login-form");
const signedIn = document.getElementById("signed-in");
const message = document.getElementById("message");
const sourceRadios = document.querySelectorAll('input[name="source-mode"]');
const targetRadios = document.querySelectorAll('input[name="target-type"]');
let authenticated = false;
let pendingManualContent = null;

const errorDescriptions = {
  LOGIN_REQUIRED: "로그인이 필요하거나 JWT가 만료되었습니다.",
  ACCOUNT_NOT_SELECTED: "먼저 AWS 계정을 선택하세요.",
  ACCOUNT_ID_REQUIRED: "파일에 계정 ID가 없습니다. 아래에 12자리 ID를 입력하세요.",
  INVALID_ACCOUNT_ID: "AWS 계정 ID는 12자리 숫자여야 합니다.",
  OPEN_EC2_CONSOLE_FIRST: "EC2 콘솔 탭에서 확장 팝업을 열어주세요.",
  PRIVATE_API_UNREACHABLE: "서버에 연결할 수 없습니다. 사내망/VPN·DNS·VPCE를 확인하세요.",
  API_TIMEOUT: "서버 응답 시간이 초과되었습니다. VPN/네트워크를 확인하세요.",
  API_GATEWAY_FORBIDDEN: "API Gateway가 요청을 거부했습니다. 네트워크·인증 정책을 확인하세요.",
  ACCOUNT_ACCESS_DENIED: "이 AWS 계정의 정책 조회 권한이 없습니다.",
  API_ROUTE_NOT_FOUND: "API Gateway의 주소·스테이지·경로를 확인하세요.",
  TAG_POLICY_NOT_FOUND: "이 계정에 적용된 Tag Policy가 없습니다.",
  POLICY_UNAVAILABLE: "정책 서버 조회에 실패했습니다. Lambda 로그를 확인하세요.",
  MANUAL_POLICY_NOT_IMPORTED: "현재 계정의 정책 JSON을 가져오세요.",
  INVALID_POLICY_JSON: "정책 JSON 형식이 올바르지 않습니다.",
  REQUIRE_EFFECTIVE_POLICY: "최종 Effective Tag Policy JSON을 선택하세요.",
  POLICY_ACCOUNT_MISMATCH: "정책 파일의 AWS 계정 ID와 입력한 ID가 일치하지 않습니다.",
  POLICY_FILE_TOO_LARGE: "정책 파일이 너무 큽니다 (개별 128KiB / OU 묶음 2MiB).",
  DUPLICATE_TAG_KEYS: "정책에 중복된 태그 키가 있습니다.",
  INVALID_OU_BUNDLE: "OU 정책 묶음 파일 구조가 올바르지 않습니다.",
  INVALID_OU_SELECTOR: "OU 이름 또는 ID를 확인하세요.",
  OU_NOT_FOUND_OR_NOT_AUTHORIZED: "조회 가능한 OU가 없거나 권한이 없습니다.",
  OU_DISCOVERY_UNAVAILABLE: "OU 탐색에 실패했습니다. 관리자에게 문의하세요.",
  OU_DISCOVERY_LIMIT: "OU 조회 한도를 초과했습니다. 관리자에게 오프라인 파일을 요청하세요."
};

function describe(error) {
  return errorDescriptions[error.message] || error.message;
}

function checkedValue(name) {
  return document.querySelector(`input[name="${name}"]:checked`)?.value;
}

function showCurrentAccount(accountId) {
  const indicator = document.getElementById("current-selection");
  indicator.hidden = !accountId;
  indicator.textContent = accountId ? `현재 적용 계정: ${accountId} · EC2 콘솔 계정과 확인하세요.` : "";
}

function showAccounts(accounts) {
  const section = document.getElementById("ou-accounts-section");
  const select = document.getElementById("ou-accounts");
  select.replaceChildren();
  for (const account of accounts) {
    const option = document.createElement("option");
    option.value = account.accountId;
    option.textContent = `${account.accountName || "AWS 계정"} (${account.accountId}) · ${account.tagKeyCount}개 키`;
    select.append(option);
  }
  section.hidden = accounts.length === 0;
}

function showTargetType() {
  const isOu = checkedValue("target-type") === "ou";
  document.getElementById("account-form").hidden = isOu;
  document.getElementById("ou-form").hidden = !isOu;
  if (!isOu) document.getElementById("ou-matches-section").hidden = true;
  document.getElementById("ou-accounts-section").hidden = true;
}

function showMode(mode) {
  for (const radio of sourceRadios) radio.checked = radio.value === mode;
  document.getElementById("server-mode").hidden = mode !== "server";
  document.getElementById("file-mode").hidden = mode !== "file";
  loginForm.hidden = mode !== "server" || authenticated;
  signedIn.hidden = mode !== "server" || !authenticated;
  document.getElementById("server-workflow").hidden = mode !== "server" || !authenticated;
  if (mode === "server") showTargetType();
}

async function activeTabId() {
  const tabs = await api.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id ?? null;
}

async function request(payload) {
  const response = await api.runtime.sendMessage(payload);
  if (!response?.ok) throw new Error(response?.error || "REQUEST_FAILED");
  return response.data;
}

async function refresh() {
  const state = await request({ type: "STATUS", tabId: await activeTabId() });
  authenticated = state.authenticated;
  document.getElementById("account-id").value = state.accountId || "";
  showMode(state.mode);
  showCurrentAccount(!state.mode || (state.mode === "file" && !state.manualImported) ? null : state.accountId);
  // A previously imported OU bundle is still usable after the popup is reopened.
  if (state.mode === "file") showAccounts(state.manualAccounts?.length > 1 ? state.manualAccounts : []);
}

async function loadOu(ouId, ouName) {
  message.textContent = "OU 하위 계정의 최종 정책을 가져오는 중...";
  const result = await request({ type: "GET_OU_POLICIES", tabId: await activeTabId(), ouId, ouName });
  if (result.ambiguous) {
    const select = document.getElementById("ou-matches");
    select.replaceChildren();
    for (const candidate of result.matches) {
      const option = document.createElement("option");
      option.value = candidate.id;
      option.textContent = `${candidate.path || candidate.name} (${candidate.id})`;
      select.append(option);
    }
    document.getElementById("ou-matches-section").hidden = false;
    message.textContent = "OU 이름이 중복됩니다. 정확한 경로를 선택하세요.";
    return;
  }
  document.getElementById("ou-matches-section").hidden = true;
  showAccounts(result.accounts);
  message.textContent = `${result.ou.name}: ${result.accounts.length}개 계정 정책 조회 완료. 적용할 계정을 선택하세요.`;
}

async function applyManualPolicy(content, accountId = "") {
  const payload = { type: "IMPORT_POLICY", content, tabId: await activeTabId() };
  if (accountId) payload.accountId = accountId;
  const result = await request(payload);
  pendingManualContent = null;
  document.getElementById("manual-account-form").hidden = true;
  await refresh();
  if (result.accounts) {
    showAccounts(result.accounts);
    message.textContent = `OU ${result.ou.name}: ${result.accountCount}개 계정 불러옴. 적용할 계정을 선택하세요.`;
  } else {
    showAccounts([]);
    message.textContent = `파일 적용 완료: ${result.accountId} · 태그 키 ${result.tagKeyCount}개`;
  }
}

loginForm.addEventListener("submit", async event => {
  event.preventDefault();
  const username = document.getElementById("username").value;
  const passwordInput = document.getElementById("password");
  const password = passwordInput.value;
  passwordInput.value = "";
  message.textContent = "로그인 중...";
  try {
    await request({ type: "LOGIN", username, password });
    await refresh();
    message.textContent = "로그인 완료. AWS 계정 ID 또는 OU를 선택하세요.";
  } catch (error) {
    message.textContent = `로그인 실패: ${describe(error)}`;
  }
});

document.getElementById("logout").addEventListener("click", async () => {
  try {
    await request({ type: "LOGOUT" });
    await refresh();
    message.textContent = "로그아웃했습니다.";
  } catch (error) {
    message.textContent = `로그아웃 실패: ${describe(error)}`;
  }
});

for (const radio of sourceRadios) radio.addEventListener("change", async () => {
  if (!radio.checked) return;
  try {
    await request({ type: "SELECT_MODE", mode: radio.value, tabId: await activeTabId() });
    pendingManualContent = null;
    document.getElementById("manual-account-form").hidden = true;
    showAccounts([]);
    await refresh();
    message.textContent = radio.value === "file" ? "정책 JSON 파일을 선택하세요." : "사내 로그인 후 조회할 대상을 선택하세요.";
  } catch (error) {
    message.textContent = `방식 변경 실패: ${describe(error)}`;
    await refresh();
  }
});

for (const radio of targetRadios) radio.addEventListener("change", () => {
  if (radio.checked) showTargetType();
});

document.getElementById("account-form").addEventListener("submit", async event => {
  event.preventDefault();
  const accountId = document.getElementById("account-id").value.trim();
  message.textContent = "계정 정책 조회 중...";
  try {
    const result = await request({ type: "LOAD_ACCOUNT_POLICY", accountId, tabId: await activeTabId() });
    showAccounts([]);
    showCurrentAccount(result.accountId);
    message.textContent = `계정 ${result.accountId}: 태그 키 ${result.tagKeyCount}개를 가져왔습니다.`;
  } catch (error) {
    message.textContent = `조회 실패: ${describe(error)}`;
  }
});

document.getElementById("ou-form").addEventListener("submit", async event => {
  event.preventDefault();
  const selector = document.getElementById("ou-selector").value.trim();
  try {
    if (selector.startsWith("ou-")) await loadOu(selector, "");
    else await loadOu("", selector);
  } catch (error) {
    message.textContent = `OU 조회 실패: ${describe(error)}`;
  }
});

document.getElementById("use-ou-match").addEventListener("click", async () => {
  try { await loadOu(document.getElementById("ou-matches").value, ""); }
  catch (error) { message.textContent = `OU 조회 실패: ${describe(error)}`; }
});

document.getElementById("use-ou-account").addEventListener("click", async () => {
  const accountId = document.getElementById("ou-accounts").value;
  try {
    await request({ type: "SELECT_ACCOUNT", accountId, tabId: await activeTabId() });
    showCurrentAccount(accountId);
    message.textContent = `계정 ${accountId} 적용 완료. 현재 EC2 콘솔 계정과 확인하세요.`;
  } catch (error) {
    message.textContent = `계정 적용 실패: ${describe(error)}`;
  }
});

document.getElementById("policy-file").addEventListener("change", async event => {
  const file = event.target.files?.[0];
  if (!file) return;
  if (file.size > 2_097_152) {
    message.textContent = errorDescriptions.POLICY_FILE_TOO_LARGE;
    event.target.value = "";
    return;
  }
  try {
    const content = await file.text();
    await applyManualPolicy(content);
  } catch (error) {
    if (error.message === "ACCOUNT_ID_REQUIRED") {
      pendingManualContent = await file.text();
      document.getElementById("manual-account-form").hidden = false;
      message.textContent = errorDescriptions.ACCOUNT_ID_REQUIRED;
    } else {
      pendingManualContent = null;
      document.getElementById("manual-account-form").hidden = true;
      message.textContent = `파일 가져오기 실패: ${describe(error)}`;
    }
  } finally {
    event.target.value = "";
  }
});

document.getElementById("manual-account-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (!pendingManualContent) return;
  try {
    await applyManualPolicy(pendingManualContent, document.getElementById("manual-account-id").value.trim());
  } catch (error) {
    message.textContent = `파일 적용 실패: ${describe(error)}`;
  }
});

refresh().catch(() => { message.textContent = "EC2 콘솔 탭에서 다시 열어주세요."; });
