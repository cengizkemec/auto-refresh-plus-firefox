"use strict";

const $ = (id) => document.getElementById(id);

const UI_LOCALE = browser.i18n.getUILanguage() || "en-US";

function t(key, substitutions) {
  const message = browser.i18n.getMessage(key, substitutions);
  return message || key;
}

const els = {
  tabTitle: $("tab-title"),
  statePill: $("state-pill"),
  statusCard: $("status-card"),
  ring: $("ring"),
  countdown: $("countdown"),
  ringLabel: $("ring-label"),
  statusTitle: $("status-title"),
  statusSub: $("status-sub"),
  reloads: $("reloads"),
  form: $("settings-form"),
  fields: $("settings-fields"),
  intervalBlock: $("interval-block"),
  presets: $("presets"),
  interval: $("interval"),
  random: $("random"),
  randomRow: $("random-row"),
  min: $("min"),
  max: $("max"),
  bypassCache: $("bypass-cache"),
  error: $("error"),
  toggle: $("toggle"),
  refreshNow: $("refresh-now")
};

let tabId = null;
let tabUrl = "";
let currentState = null;
let pollTimer = null;
let pollInFlight = false;
let actionError = "";

/* ------------------------------------------------------------------ */
/* Yerelleştirme                                                       */
/* ------------------------------------------------------------------ */

function localizeStaticUi() {
  const language = browser.i18n.getUILanguage() || "en";
  document.documentElement.lang = language.split(/[-_]/)[0];
  document.title = t("extensionName");

  for (const node of document.querySelectorAll("[data-i18n]")) {
    const key = node.dataset.i18n;
    const message = t(key);
    if (message && message !== key) node.textContent = message;
  }

  for (const node of document.querySelectorAll("[data-i18n-placeholder]")) {
    const key = node.dataset.i18nPlaceholder;
    const message = t(key);
    if (message && message !== key) node.setAttribute("placeholder", message);
  }

  for (const node of document.querySelectorAll("[data-i18n-title]")) {
    const key = node.dataset.i18nTitle;
    const message = t(key);
    if (message && message !== key) node.setAttribute("title", message);
  }

  for (const node of document.querySelectorAll("[data-i18n-aria-label]")) {
    const key = node.dataset.i18nAriaLabel;
    const message = t(key);
    if (message && message !== key) node.setAttribute("aria-label", message);
  }

  for (const button of els.presets.querySelectorAll("button[data-seconds]")) {
    button.textContent = formatShort(Number(button.dataset.seconds));
  }
}

/* ------------------------------------------------------------------ */
/* Yardımcılar                                                         */
/* ------------------------------------------------------------------ */

function send(message) {
  return browser.runtime.sendMessage(message).catch((error) => {
    console.warn("Auto Refresh Plus: mesaj gönderilemedi", error);
    return null;
  });
}

function truncate(text, maxLength) {
  if (!text) return "";
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function isRestrictedUrl(url) {
  return /^(about|moz-extension|chrome|resource|view-source|data):/i.test(url || "");
}

function toInt(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function formatClock(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(secs).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

function formatShort(seconds) {
  const value = Math.max(1, Math.round(Number(seconds) || 1));

  if (value < 60) {
    return t("durationSeconds", [String(value)]);
  }

  if (value < 3600) {
    const minutes = Math.floor(value / 60);
    const rest = value % 60;
    return rest === 0
      ? t("durationMinutes", [String(minutes)])
      : t("durationMinutesSeconds", [String(minutes), String(rest)]);
  }

  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  return minutes === 0
    ? t("durationHours", [String(hours)])
    : t("durationHoursMinutes", [String(hours), String(minutes)]);
}

function nextRefreshText(state) {
  const remaining = Number(state.remaining) || 0;
  if (remaining <= 0) return t("refreshingNow");
  if (!state.nextAt) return t("statusSubOff");

  const time = new Intl.DateTimeFormat(UI_LOCALE, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(state.nextAt));

  return t("nextRefresh", [time]);
}

/* ------------------------------------------------------------------ */
/* Hata gösterimi                                                      */
/* ------------------------------------------------------------------ */

function showActionError(message) {
  actionError = message || t("errorUnexpected");
  els.error.textContent = actionError;
  els.error.hidden = false;
}

function clearErrors() {
  actionError = "";
  els.error.textContent = "";
  els.error.hidden = true;
}

function syncStateError(state) {
  if (actionError) return;
  if (state && state.error) {
    els.error.textContent = state.error;
    els.error.hidden = false;
  } else {
    els.error.textContent = "";
    els.error.hidden = true;
  }
}

/* ------------------------------------------------------------------ */
/* Form                                                                */
/* ------------------------------------------------------------------ */

function updateRandomVisibility() {
  const random = els.random.checked;
  els.intervalBlock.hidden = random;
  els.randomRow.hidden = !random;
}

function updatePresetHighlight() {
  const interval = toInt(els.interval.value);
  const random = els.random.checked;

  for (const button of els.presets.querySelectorAll("button[data-seconds]")) {
    const seconds = Number(button.dataset.seconds);
    button.classList.toggle("is-active", !random && seconds === interval);
  }
}

function applyStateToForm(state) {
  const settings = state && state.active ? state : state && state.lastSettings;
  if (!settings) return;

  els.interval.value = String(settings.interval ?? 30);
  els.min.value = String(settings.min ?? 15);
  els.max.value = String(settings.max ?? 45);
  els.random.checked = settings.mode === "random";
  els.bypassCache.checked = Boolean(settings.bypassCache);

  updateRandomVisibility();
  updatePresetHighlight();
}

function readSettings() {
  return {
    mode: els.random.checked ? "random" : "fixed",
    interval: toInt(els.interval.value),
    min: toInt(els.min.value),
    max: toInt(els.max.value),
    bypassCache: els.bypassCache.checked
  };
}

function validateSettings(settings) {
  if (!Number.isFinite(settings.interval) || settings.interval < 1 || settings.interval > 86400) {
    return t("errorInvalidInterval");
  }

  if (settings.mode === "random") {
    if (
      !Number.isFinite(settings.min) ||
      !Number.isFinite(settings.max) ||
      settings.min < 1 ||
      settings.max > 86400
    ) {
      return t("errorInvalidRandomRange");
    }
    if (settings.min > settings.max) {
      return t("errorMinGreater");
    }
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* Görünüm                                                             */
/* ------------------------------------------------------------------ */

function render(state) {
  if (!state) return;
  currentState = state;

  const active = Boolean(state.active);
  const restricted = isRestrictedUrl(tabUrl);

  els.statePill.textContent = active ? t("statusOn") : t("statusOff");
  els.statePill.classList.toggle("on", active);
  els.statusCard.classList.toggle("active", active);

  if (active) {
    const remaining = Math.max(0, Number(state.remaining) || 0);
    const duration = Math.max(0, Number(state.cycleDuration) || 0);
    const ratio = duration > 0 ? Math.min(1, remaining / duration) : 0;

    els.countdown.textContent = formatClock(remaining);
    els.ringLabel.textContent = t("ringRemaining");
    els.ring.style.setProperty("--progress", `${(ratio * 360).toFixed(1)}deg`);

    els.statusTitle.textContent =
      state.mode === "random"
        ? t("statusRandom", [String(state.min), String(state.max)])
        : t("statusEvery", [formatShort(state.interval)]);
    els.statusSub.textContent = nextRefreshText(state);
    const reloadCount = Number(state.reloads) || 0;
    els.reloads.textContent =
      reloadCount > 0
        ? reloadCount === 1
          ? t("reloadsCountOne")
          : t("reloadsCount", [String(reloadCount)])
        : t("neverRefreshed");

    els.toggle.textContent = t("stopButton");
    els.toggle.classList.add("is-stop");
    els.toggle.disabled = false;
  } else {
    els.countdown.textContent = "—";
    els.ringLabel.textContent = t("ringReady");
    els.ring.style.setProperty("--progress", "0deg");
    els.statusTitle.textContent = t("statusTitleOff");
    els.statusSub.textContent = restricted ? t("statusSubRestricted") : t("statusSubOff");
    els.reloads.textContent = "";
    els.toggle.textContent = t("startButton");
    els.toggle.classList.remove("is-stop");
    els.toggle.disabled = restricted;
  }

  els.fields.disabled = active || restricted;
  els.refreshNow.disabled = restricted;

  syncStateError(state);
}

function renderUnavailable(message) {
  els.statePill.textContent = "—";
  els.statePill.classList.remove("on");
  els.statusCard.classList.remove("active");
  els.ring.style.setProperty("--progress", "0deg");
  els.countdown.textContent = "—";
  els.ringLabel.textContent = t("ringReady");
  els.statusTitle.textContent = t("unavailableTitle");
  els.statusSub.textContent = t("unavailableSub");
  els.reloads.textContent = "";
  els.fields.disabled = true;
  els.toggle.disabled = true;
  els.refreshNow.disabled = true;
  if (message) showActionError(message);
}

/* ------------------------------------------------------------------ */
/* Durum yenileme                                                      */
/* ------------------------------------------------------------------ */

async function refreshState() {
  if (tabId === null || pollInFlight) return;
  pollInFlight = true;

  try {
    const state = await send({ type: "arp:get-state", tabId });
    if (!state) return;

    const wasActive = Boolean(currentState && currentState.active);
    const isActive = Boolean(state.active);

    if (wasActive !== isActive) {
      applyStateToForm(state);
    }

    render(state);
  } finally {
    pollInFlight = false;
  }
}

function startPolling() {
  stopPolling();
  pollTimer = window.setInterval(() => {
    void refreshState();
  }, 500);
}

function stopPolling() {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}

/* ------------------------------------------------------------------ */
/* Olaylar                                                             */
/* ------------------------------------------------------------------ */

function bindEvents() {
  els.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (tabId === null) return;

    clearErrors();

    if (currentState && currentState.active) {
      els.toggle.disabled = true;
      const result = await send({ type: "arp:stop", tabId });

      if (result && result.ok && result.state) {
        currentState = result.state;
        applyStateToForm(result.state);
        render(result.state);
      } else {
        els.toggle.disabled = false;
        await refreshState();
        showActionError(result && result.error ? result.error : t("errorCannotStop"));
      }
      return;
    }

    const settings = readSettings();
    const problem = validateSettings(settings);
    if (problem) {
      showActionError(problem);
      return;
    }

    els.toggle.disabled = true;
    const result = await send({ type: "arp:start", tabId, settings });

    if (result && result.ok && result.state) {
      currentState = result.state;
      applyStateToForm(result.state);
      render(result.state);
    } else {
      els.toggle.disabled = false;
      await refreshState();
      showActionError(result && result.error ? result.error : t("errorCannotStart"));
    }
  });

  els.random.addEventListener("change", () => {
    updateRandomVisibility();
    updatePresetHighlight();
  });

  els.interval.addEventListener("input", updatePresetHighlight);

  els.presets.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-seconds]");
    if (!button || els.fields.disabled) return;

    els.interval.value = button.dataset.seconds;
    updatePresetHighlight();
  });

  els.refreshNow.addEventListener("click", async () => {
    if (tabId === null) return;

    clearErrors();
    els.refreshNow.disabled = true;

    const result = await send({ type: "arp:refresh-now", tabId });

    if (!result || result.ok !== true) {
      els.refreshNow.disabled = false;
      showActionError(result && result.error ? result.error : t("errorRefreshRequest"));
      return;
    }

    window.setTimeout(() => {
      els.refreshNow.disabled = false;
    }, 1200);
  });

  window.addEventListener("unload", stopPolling);
}

/* ------------------------------------------------------------------ */
/* Başlangıç                                                           */
/* ------------------------------------------------------------------ */

async function init() {
  localizeStaticUi();
  bindEvents();

  let tab = null;
  try {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    tab = tabs[0] || null;
  } catch (error) {
    console.warn("Auto Refresh Plus: sekme bilgisi alınamadı", error);
  }

  if (!tab || !Number.isInteger(tab.id)) {
    renderUnavailable();
    return;
  }

  tabId = tab.id;
  tabUrl = tab.url || tab.pendingUrl || "";
  els.tabTitle.textContent = tab.title ? truncate(tab.title, 44) : t("tabFallback");
  els.tabTitle.title = tab.title || tabUrl || "";

  const state = await send({ type: "arp:get-state", tabId });

  if (!state) {
    renderUnavailable(t("errorNoBackground"));
    return;
  }

  applyStateToForm(state);
  render(state);
  startPolling();
}

void init();
