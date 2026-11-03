const api = globalThis.browser || globalThis.chrome;
const form = document.getElementById("login-form");
const signedIn = document.getElementById("signed-in");
const message = document.getElementById("message");

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
  form.hidden = state.authenticated;
  signedIn.hidden = !state.authenticated;
  document.getElementById("account-id").value = state.accountId || "";
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

refresh().catch(() => { message.textContent = "확장 프로그램을 다시 시작해 주세요."; });
