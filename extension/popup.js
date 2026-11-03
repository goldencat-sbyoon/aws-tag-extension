const api = globalThis.browser || globalThis.chrome;
const form = document.getElementById("login-form");
const signedIn = document.getElementById("signed-in");
const message = document.getElementById("message");
const sourceSelect = document.getElementById("source-mode");
let authenticated = false;

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

async function loadOu(ouId, ouName) {
  message.textContent = "OU 및 하위 계정별 정책 조회 중... (계정 수에 따라 시간이 걸립니다)";
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
    message.textContent = "OU 이름이 중복됩니다. 해당 OU를 선택하세요.";
    return;
  }
  document.getElementById("ou-matches-section").hidden = true;
  showAccounts(result.accounts);
  message.textContent = `${result.ou.name}: 허용된 ${result.accounts.length}개 계정의 최종 정책을 조회했습니다. 계정을 선택하세요.`;
}

function showMode(mode) {
  sourceSelect.value = mode;
  document.getElementById("server-mode").hidden = mode !== "server";
  document.getElementById("file-mode").hidden = mode !== "file";
  form.hidden = mode === "file" || authenticated;
  // Keep logout available if a previous server-mode JWT remains in the session.
  signedIn.hidden = !authenticated;
}

async function activeTabId() {
  const tabs = await api.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id ?? null;
}

function request(payload) {
  return api.runtime.sendMessage(payload).then(response => {
    if (!response?.ok) throw new Error(response?.error || "REQUEST_FAILED");
    return response.data;
  });
}

async function refresh() {
  const state = await request({ type: "STATUS", tabId: await activeTabId() });
  authenticated = state.authenticated;
  document.getElementById("account-id").value = state.accountId || "";
  showMode(state.mode || "server");
  if (state.mode === "file") showAccounts(state.manualAccounts || []);
}

form.addEventListener("submit", async event => {
  event.preventDefault();
  const username = document.getElementById("username").value;
  const passwordInput = document.getElementById("password");
  const password = passwordInput.value;
  passwordInput.value = "";
  message.textContent = "로그인 중...";
  try {
    await request({ type: "LOGIN", username, password });
    message.textContent = "로그인 성공. EC2 콘솔에서 태그 입력란을 클릭하세요.";
    await refresh();
  } catch (error) {
    message.textContent = `로그인 실패: ${error.message}`;
  }
});

document.getElementById("logout").addEventListener("click", async () => {
  await request({ type: "LOGOUT" });
  message.textContent = "로그아웃했습니다.";
  await refresh();
});

document.getElementById("account-form").addEventListener("submit", async event => {
  event.preventDefault();
  try {
    const accountId = document.getElementById("account-id").value.trim();
    await request({ type: "SELECT_ACCOUNT", accountId, tabId: await activeTabId() });
    message.textContent = `계정 ${accountId} 선택 완료. EC2 콘솔과 일치하는지 확인하세요.`;
  } catch (error) {
    message.textContent = `계정 설정 실패: ${error.message}`;
  }
});

const errorDescriptions = {
  LOGIN_REQUIRED: "로그인이 필요하거나 JWT가 만료되었습니다.",
  ACCOUNT_NOT_SELECTED: "먼저 현재 EC2 탭의 AWS 계정 ID를 설정하세요.",
  OPEN_EC2_CONSOLE_FIRST: "EC2 콘솔 탭에서 확장 팝업을 열어주세요.",
  PRIVATE_API_UNREACHABLE: "서버에 연결하지 못했습니다. VPN, 사내 DNS, VPCE 라우팅·보안 그룹을 확인하세요.",
  API_TIMEOUT: "서버 응답이 10초 내 도착하지 않았습니다. VPN/네트워크를 확인하세요.",
  API_GATEWAY_FORBIDDEN: "API Gateway에서 거부했습니다. JWT Authorizer, API Resource Policy 및 SourceVpce를 확인하세요.",
  ACCOUNT_ACCESS_DENIED: "해당 AWS 계정의 Tag Policy 조회 권한이 없습니다.",
  API_ROUTE_NOT_FOUND: "Private REST API 주소, 스테이지 및 리소스 경로를 확인하세요.",
  TAG_POLICY_NOT_FOUND: "해당 계정에 적용된 Tag Policy가 없습니다.",
  POLICY_UNAVAILABLE: "백엔드 조회 실패입니다. Lambda 로그를 확인하세요."
};

Object.assign(errorDescriptions, {
  MANUAL_POLICY_NOT_IMPORTED: "먼저 현재 계정의 정책 JSON 파일을 가져오세요.",
  INVALID_POLICY_JSON: "정책 JSON 형식이 올바르지 않습니다.",
  REQUIRE_EFFECTIVE_POLICY: "원본 Tag Policy가 아닌 Effective Tag Policy JSON을 선택하세요.",
  POLICY_ACCOUNT_MISMATCH: "파일의 AWS 계정 ID가 현재 선택한 계정과 다릅니다.",
  POLICY_FILE_TOO_LARGE: "정책 파일 크기 제한입니다 (개별 128KiB / OU 묶음 2MiB).",
  DUPLICATE_TAG_KEYS: "정책 파일에 중복된 태그 키가 있습니다.",
  INVALID_OU_BUNDLE: "OU 정책 묶음 파일 구조가 올바르지 않습니다.",
  INVALID_OU_SELECTOR: "OU ID 또는 이름을 확인하세요.",
  OU_NOT_FOUND_OR_NOT_AUTHORIZED: "조회 가능한 OU가 없거나 권한이 없습니다.",
  OU_DISCOVERY_UNAVAILABLE: "OU 탐색에 실패했습니다. Lambda 실행 역할·Organizations 권한을 확인하세요.",
  OU_DISCOVERY_LIMIT: "OU 규모가 조회 한도를 초과했습니다. 관리자에게 오프라인 묶음 파일을 요청하세요."
});

sourceSelect.addEventListener("change", async () => {
  try {
    await request({ type: "SELECT_MODE", mode: sourceSelect.value, tabId: await activeTabId() });
    showMode(sourceSelect.value);
    if (sourceSelect.value === "server") {
      document.getElementById("ou-accounts-section").hidden = true;
    } else {
      await refresh();
    }
    message.textContent = sourceSelect.value === "file" ? "파일 모드입니다. 현재 계정의 JSON 파일을 선택하세요." : "서버 연동 모드입니다.";
  } catch (error) {
    message.textContent = `모드 변경 실패: ${errorDescriptions[error.message] || error.message}`;
    await refresh();
  }
});

document.getElementById("policy-file").addEventListener("change", async event => {
  const file = event.target.files?.[0];
  if (!file) return;
  if (file.size > 2_097_152) {
    message.textContent = errorDescriptions.POLICY_FILE_TOO_LARGE;
    return;
  }
  try {
    const result = await request({ type: "IMPORT_POLICY", content: await file.text(), tabId: await activeTabId() });
    await refresh();
    if (result.accounts) {
      showAccounts(result.accounts);
      message.textContent = `OU ${result.ou.name}: ${result.accountCount}개 계정 정책 파일 적용 완료. 아래에서 계정을 선택하세요.`;
    } else {
      message.textContent = `파일 적용 완료: 계정 ${result.accountId}, 태그 키 ${result.tagKeyCount}개`;
    }
  } catch (error) {
    message.textContent = `가져오기 실패: ${errorDescriptions[error.message] || error.message}`;
  } finally {
    event.target.value = "";
  }
});

document.getElementById("ou-form").addEventListener("submit", async event => {
  event.preventDefault();
  const selector = document.getElementById("ou-selector").value.trim();
  try {
    if (selector.startsWith("ou-")) await loadOu(selector, "");
    else await loadOu("", selector);
  } catch (error) {
    message.textContent = `OU 조회 실패: ${errorDescriptions[error.message] || error.message}`;
  }
});

document.getElementById("use-ou-match").addEventListener("click", async () => {
  try { await loadOu(document.getElementById("ou-matches").value, ""); }
  catch (error) { message.textContent = `OU 조회 실패: ${errorDescriptions[error.message] || error.message}`; }
});

document.getElementById("use-ou-account").addEventListener("click", async () => {
  const accountId = document.getElementById("ou-accounts").value;
  try {
    await request({ type: "SELECT_ACCOUNT", accountId, tabId: await activeTabId() });
    await refresh();
    message.textContent = `${accountId} 계정을 선택했습니다. 현재 EC2 콘솔의 계정과 일치하는지 확인하세요.`;
  } catch (error) {
    message.textContent = `계정 선택 실패: ${errorDescriptions[error.message] || error.message}`;
  }
});

document.getElementById("test-api").addEventListener("click", async () => {
  const button = document.getElementById("test-api");
  button.disabled = true;
  message.textContent = "Private API 연결 테스트 중...";
  try {
    const result = await request({ type: "TEST_CONNECTION", tabId: await activeTabId() });
    message.textContent = `연결 성공: 계정 ${result.accountId}, 태그 키 ${result.tagKeyCount}개 조회`;
  } catch (error) {
    message.textContent = `연결 실패: ${errorDescriptions[error.message] || error.message}`;
  } finally {
    button.disabled = false;
  }
});

refresh().catch(() => { message.textContent = "확장 프로그램을 다시 시작해 주세요."; });
