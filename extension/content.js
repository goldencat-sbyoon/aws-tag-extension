/* EC2 tag input enhancement. Fail-safe: never intercept AWS form submission. */
(() => {
  const api = globalThis.browser || globalThis.chrome;
  const enhanced = new WeakSet();
  let activeDropdown = null;

  function request(payload) {
    return api.runtime.sendMessage(payload).then(response => {
      if (!response?.ok) throw new Error(response?.error || "REQUEST_FAILED");
      return response.data;
    });
  }

  function isTagKeyInput(input) {
    if (!(input instanceof HTMLInputElement) || input.disabled || input.readOnly) return false;
    if (!["text", "search", ""].includes(input.type)) return false;
    const ownLabel = [input.getAttribute("aria-label"), input.placeholder,
      input.labels && [...input.labels].map(label => label.textContent).join(" ")].filter(Boolean).join(" ");
    if (/tag\s*key/i.test(ownLabel)) return true;
    // Generic "Key" fields are accepted only inside a clearly identified tag section.
    const nearText = input.parentElement?.parentElement?.textContent?.slice(0, 250) || "";
    return /^(key|tag key)$/i.test(ownLabel.trim()) && /tags?|태그/i.test(nearText);
  }

  function updateNativeInput(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (setter) setter.call(input, value);
    else input.value = value;
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertReplacementText", data: value }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function enhance(input) {
    if (enhanced.has(input)) return;
    enhanced.add(input);
    const root = document.createElement("span");
    root.style.cssText = "position:relative;display:inline-block;width:0;height:0;vertical-align:top;z-index:2147483000";
    input.insertAdjacentElement("afterend", root);
    const shadow = root.attachShadow({ mode: "closed" });
    shadow.innerHTML = `<style>
      .panel{position:absolute;top:4px;left:0;width:260px;max-height:230px;overflow:auto;background:white;color:#17263c;border:1px solid #abb8c9;border-radius:7px;box-shadow:0 5px 18px #0002;font:13px system-ui,sans-serif;z-index:1}
      button{display:block;width:100%;padding:8px 10px;text-align:left;background:white;border:0;color:#17263c;cursor:pointer;font:inherit}button:hover,button:focus{background:#e9f2ff}
      .note{padding:9px 10px;color:#596779;font-size:12px}
    </style><div class="panel" role="listbox" hidden></div>`;
    const panel = shadow.querySelector(".panel");
    let all = [];

    function render(filter = "") {
      panel.replaceChildren();
      const matches = all.filter(entry => entry.key.toLowerCase().includes(filter.toLowerCase()));
      if (!matches.length) {
        const note = document.createElement("div");
        note.className = "note";
        note.textContent = "추천 태그 키가 없습니다.";
        panel.append(note);
      }
      for (const entry of matches) {
        const button = document.createElement("button");
        button.type = "button";
        button.setAttribute("role", "option");
        button.textContent = entry.key;
        button.addEventListener("mousedown", e => e.preventDefault());
        button.addEventListener("click", () => {
          updateNativeInput(input, entry.key);
          panel.hidden = true;
          input.focus();
        });
        panel.append(button);
      }
      panel.hidden = false;
    }

    input.addEventListener("focus", async () => {
      activeDropdown?.();
      activeDropdown = () => { panel.hidden = true; };
      try {
        const state = await request({ type: "STATUS" });
        const accountId = state.accountId;
        if (!accountId || (state.mode !== "file" && !state.authenticated)) return;
        const policy = await request({ type: "GET_POLICY", accountId });
        if (document.activeElement !== input) return;
        all = policy.tagKeys.filter(item => typeof item.key === "string" && item.valueMode !== "deny");
        render(input.value);
      } catch {
        // No overlay on authentication, policy, or network failures.
        panel.hidden = true;
      }
    });
    input.addEventListener("input", () => { if (!panel.hidden) render(input.value); });
    input.addEventListener("keydown", event => {
      if (event.key === "Escape") panel.hidden = true;
    });
    input.addEventListener("blur", () => setTimeout(() => { panel.hidden = true; }, 150));
  }

  let scheduled = false;
  function scan() {
    scheduled = false;
    document.querySelectorAll("input").forEach(input => { if (isTagKeyInput(input)) enhance(input); });
  }
  const observer = new MutationObserver(() => {
    if (!scheduled) {
      scheduled = true;
      setTimeout(scan, 100);
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  scan();
})();
