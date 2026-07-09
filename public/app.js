const state = {
  cards: [],
  filter: "all",
  search: ""
};

const els = {
  token: document.querySelector("#adminToken"),
  createForm: document.querySelector("#createForm"),
  refreshBtn: document.querySelector("#refreshBtn"),
  deleteAllBtn: document.querySelector("#deleteAllBtn"),
  cardsBody: document.querySelector("#cardsBody"),
  emptyState: document.querySelector("#emptyState"),
  searchInput: document.querySelector("#searchInput"),
  statusFilter: document.querySelector("#statusFilter"),
  createdBox: document.querySelector("#createdBox"),
  createdCards: document.querySelector("#createdCards"),
  copyCreatedBtn: document.querySelector("#copyCreatedBtn"),
  toast: document.querySelector("#toast"),
  statTotal: document.querySelector("#statTotal"),
  statUnused: document.querySelector("#statUnused"),
  statActive: document.querySelector("#statActive"),
  statClosed: document.querySelector("#statClosed")
};

function token() {
  return els.token.value.trim();
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => els.toast.classList.remove("show"), 1800);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Admin-Token": token(),
      ...(options.headers || {})
    }
  });
  const body = await response.json();
  if (!response.ok || body.ok === false) {
    throw new Error(body.message || "请求失败");
  }
  return body;
}

function formatDate(seconds) {
  if (!seconds) return "-";
  return new Date(seconds * 1000).toLocaleString("zh-CN", { hour12: false });
}

function formatDuration(seconds) {
  if (!seconds) return "-";
  const day = Math.floor(seconds / 86400);
  const hour = Math.floor((seconds % 86400) / 3600);
  const minute = Math.floor((seconds % 3600) / 60);
  if (day > 0) return `${day}天${hour ? ` ${hour}小时` : ""}`;
  if (hour > 0) return `${hour}小时${minute ? ` ${minute}分钟` : ""}`;
  return `${Math.max(1, minute)}分钟`;
}

function statusText(status) {
  return {
    unused: "未使用",
    active: "使用中",
    expired: "已过期",
    disabled: "已禁用"
  }[status] || status;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function filteredCards() {
  const keyword = state.search.trim().toLowerCase();
  return state.cards.filter(card => {
    const matchesStatus = state.filter === "all" || card.status === state.filter;
    const text = `${card.cardKey} ${card.deviceId || ""} ${card.note || ""}`.toLowerCase();
    return matchesStatus && (!keyword || text.includes(keyword));
  });
}

function renderStats() {
  const total = state.cards.length;
  const unused = state.cards.filter(card => card.status === "unused").length;
  const active = state.cards.filter(card => card.status === "active").length;
  const closed = state.cards.filter(card => card.status === "expired" || card.status === "disabled").length;
  els.statTotal.textContent = total;
  els.statUnused.textContent = unused;
  els.statActive.textContent = active;
  els.statClosed.textContent = closed;
}

function renderCards() {
  renderStats();
  const cards = filteredCards();
  els.emptyState.hidden = cards.length !== 0;
  els.cardsBody.innerHTML = cards.map(card => {
    const canDisable = card.status !== "disabled";
    const canEnable = card.status === "disabled";
    return `
      <tr>
        <td>
          <div class="key">${escapeHtml(card.cardKey)}</div>
          <button class="ghost small" data-action="copy" data-key="${escapeHtml(card.cardKey)}" type="button">复制</button>
        </td>
        <td><span class="status ${escapeHtml(card.status)}">${statusText(card.status)}</span></td>
        <td>
          <div>${formatDuration(card.durationSeconds)}</div>
          <div class="muted">到期：${formatDate(card.expiresAt)}</div>
          <div class="muted">剩余：${card.remainingSeconds == null ? "-" : formatDuration(card.remainingSeconds)}</div>
        </td>
        <td>
          <div>${escapeHtml(card.deviceId || "-")}</div>
          <div class="muted">版本：${escapeHtml(card.appVersion || "-")}</div>
        </td>
        <td>
          <div>激活：${formatDate(card.activatedAt)}</div>
          <div class="muted">心跳：${formatDate(card.lastHeartbeatAt)}</div>
        </td>
        <td>${escapeHtml(card.note || "")}</td>
        <td>
          <div class="actions">
            ${canDisable ? `<button class="ghost small" data-action="disable" data-key="${escapeHtml(card.cardKey)}" type="button">禁用</button>` : ""}
            ${canEnable ? `<button class="ghost small" data-action="enable" data-key="${escapeHtml(card.cardKey)}" type="button">启用</button>` : ""}
            <button class="ghost small" data-action="reset" data-key="${escapeHtml(card.cardKey)}" type="button">重置</button>
            <button class="danger small" data-action="delete" data-key="${escapeHtml(card.cardKey)}" type="button">删除</button>
          </div>
        </td>
      </tr>
    `;
  }).join("");
}

async function loadCards() {
  const body = await api("/admin/cards");
  state.cards = body.cards || [];
  renderCards();
}

async function createCards(event) {
  event.preventDefault();
  const form = new FormData(els.createForm);
  const payload = {
    count: Number(form.get("count")),
    duration: Number(form.get("duration")),
    unit: form.get("unit"),
    note: form.get("note")
  };
  const body = await api("/admin/cards", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  const keys = body.cards.map(card => card.cardKey).join("\n");
  els.createdCards.value = keys;
  els.createdBox.hidden = false;
  showToast(`已生成 ${body.cards.length} 张卡密`);
  await loadCards();
}

async function updateCard(cardKey, action) {
  await api(`/admin/cards/${encodeURIComponent(cardKey)}`, {
    method: "PATCH",
    body: JSON.stringify({ action })
  });
  showToast("已更新");
  await loadCards();
}

async function deleteCard(cardKey) {
  if (!window.confirm(`确认删除 ${cardKey}？`)) return;
  await api(`/admin/cards/${encodeURIComponent(cardKey)}`, { method: "DELETE" });
  showToast("已删除");
  await loadCards();
}

async function deleteAllCards() {
  if (!window.confirm("确认删除全部卡密？这个操作不能恢复。")) return;
  const body = await api("/admin/cards", { method: "DELETE" });
  els.createdBox.hidden = true;
  els.createdCards.value = "";
  showToast(`已删除 ${body.deleted} 张卡密`);
  await loadCards();
}

els.createForm.addEventListener("submit", event => {
  createCards(event).catch(error => showToast(error.message));
});

els.refreshBtn.addEventListener("click", () => {
  loadCards().then(() => showToast("已刷新")).catch(error => showToast(error.message));
});

els.deleteAllBtn.addEventListener("click", () => {
  deleteAllCards().catch(error => showToast(error.message));
});

els.searchInput.addEventListener("input", event => {
  state.search = event.target.value;
  renderCards();
});

els.statusFilter.addEventListener("change", event => {
  state.filter = event.target.value;
  renderCards();
});

els.copyCreatedBtn.addEventListener("click", async () => {
  await navigator.clipboard.writeText(els.createdCards.value);
  showToast("已复制");
});

els.cardsBody.addEventListener("click", async event => {
  const button = event.target.closest("button");
  if (!button) return;
  const action = button.dataset.action;
  const cardKey = button.dataset.key;
  try {
    if (action === "copy") {
      await navigator.clipboard.writeText(cardKey);
      showToast("已复制");
    } else if (action === "delete") {
      await deleteCard(cardKey);
    } else {
      await updateCard(cardKey, action);
    }
  } catch (error) {
    showToast(error.message);
  }
});

loadCards().catch(error => showToast(error.message));
