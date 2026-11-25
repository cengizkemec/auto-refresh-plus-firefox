"use strict";

/*
 * Auto Refresh Plus (Firefox)
 * Sekme başına otomatik yenileme zamanlayıcısı.
 */

const DEFAULT_SETTINGS = Object.freeze({
  mode: "fixed",
  interval: 30,
  min: 15,
  max: 45,
  bypassCache: false
});

const TICK_MS = 250;
const MIN_INTERVAL = 1;
const MAX_INTERVAL = 86400;

const SESSION_COLOR = "#2563eb";
const ERROR_COLOR = "#dc2626";

const sessions = new Map();
const lastErrors = new Map();

let lastSettings = { ...DEFAULT_SETTINGS };

const MENU_TOGGLE = "arp-menu-toggle";
const MENU_NOW = "arp-menu-now";
const MENU_PRESETS = "arp-menu-presets";
const MENU_START_PREFIX = "arp-menu-start:";
const MENU_INTERVALS = [5, 10, 30, 60, 300, 900];

/* ------------------------------------------------------------------ */
/* Yerelleştirme                                                       */
/* ------------------------------------------------------------------ */

function t(key, substitutions) {
  const message = browser.i18n.getMessage(key, substitutions);
  return message || key;
}

/* ------------------------------------------------------------------ */
/* Yardımcılar                                                         */
/* ------------------------------------------------------------------ */

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function toTabId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id >= 0 ? id : null;
}

function normalizeSettings(raw = {}) {
  const settings = {
    mode: raw.mode === "random" ? "random" : "fixed",
    interval: clampInt(raw.interval, MIN_INTERVAL, MAX_INTERVAL, lastSettings.interval),
    min: clampInt(raw.min, MIN_INTERVAL, MAX_INTERVAL, lastSettings.min),
    max: clampInt(raw.max, MIN_INTERVAL, MAX_INTERVAL, lastSettings.max),
    bypassCache:
      typeof raw.bypassCache === "boolean"
        ? raw.bypassCache
        : lastSettings.bypassCache
  };

  if (settings.min > settings.max) {
    const temporary = settings.min;
    settings.min = settings.max;
    settings.max = temporary;
  }

  return settings;
}

function formatDuration(seconds) {
  const value = Math.max(1, Math.round(seconds));

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

function formatBadge(seconds) {
  const value = Math.max(0, Math.ceil(seconds));
  if (value < 100) return String(value);
  if (value < 3600) return `${Math.ceil(value / 60)}m`;
  return `${Math.ceil(value / 3600)}h`;
}

function friendlyError(error) {
  if (error) console.warn("Auto Refresh Plus:", error);
  return t("errorReloadFailed");
}

function isRestrictedUrl(url) {
  return /^(about|moz-extension|chrome|resource|view-source|data):/i.test(url || "");
}

async function setBadge(tabId, text, color) {
  try {
    await Promise.all([
      browser.browserAction.setBadgeText({ tabId, text }),
      browser.browserAction.setBadgeBackgroundColor({ tabId, color })
    ]);
  } catch (error) {
    /* Sekme kapanmış olabilir. */
  }
}

async function clearBadge(tabId) {
  try {
    await browser.browserAction.setBadgeText({ tabId, text: "" });
  } catch (error) {
    /* Sekme kapanmış olabilir. */
  }
}

async function setTabTitle(tabId, title) {
  try {
    await browser.browserAction.setTitle({ tabId, title });
  } catch (error) {
    /* Sekme kapanmış olabilir. */
  }
}

function sessionTitle(session) {
  if (session.mode === "random") {
    return t("titleRandom", [String(session.min), String(session.max)]);
  }
  return t("titleRefreshingEvery", [formatDuration(session.interval)]);
}

async function ensureReloadable(tabId) {
  try {
    const tab = await browser.tabs.get(tabId);
    if (!tab) return t("errorTabNotFound");
    if (isRestrictedUrl(tab.url || tab.pendingUrl || "")) {
      return t("errorRestrictedPage");
    }
    return null;
  } catch (error) {
    return t("errorTabNotFound");
  }
}

async function getActiveTab() {
  let tabs = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tabs.length) {
    tabs = await browser.tabs.query({ active: true, currentWindow: true });
  }
  return tabs[0] || null;
}

/* ------------------------------------------------------------------ */
/* Ayarlar                                                             */
/* ------------------------------------------------------------------ */

async function loadLastSettings() {
  try {
    const data = await browser.storage.local.get("lastSettings");
    if (data && data.lastSettings && typeof data.lastSettings === "object") {
      lastSettings = normalizeSettings({
        ...DEFAULT_SETTINGS,
        ...data.lastSettings
      });
    }
  } catch (error) {
    console.warn("Auto Refresh Plus: ayarlar okunamadı", error);
  }
}

const ready = loadLastSettings();

async function rememberSettings(settings) {
  lastSettings = { ...settings };
  try {
    await browser.storage.local.set({ lastSettings });
  } catch (error) {
    console.warn("Auto Refresh Plus: ayarlar kaydedilemedi", error);
  }
}

/* ------------------------------------------------------------------ */
/* Oturumlar                                                           */
/* ------------------------------------------------------------------ */

function pickDelaySeconds(session) {
  if (session.mode === "random") {
    const span = session.max - session.min + 1;
    return session.min + Math.floor(Math.random() * span);
  }
  return session.interval;
}

function scheduleNext(session, from = Date.now()) {
  const delay = pickDelaySeconds(session);
  session.currentDelay = delay;
  session.cycleStartAt = from;
  session.nextAt = from + delay * 1000;
  session.lastBadge = null;
}

function sessionState(session) {
  const remaining = Math.max(0, Math.ceil((session.nextAt - Date.now()) / 1000));
  return {
    active: true,
    mode: session.mode,
    interval: session.interval,
    min: session.min,
    max: session.max,
    bypassCache: session.bypassCache,
    remaining,
    cycleDuration: session.currentDelay,
    reloads: session.reloads,
    startedAt: session.startedAt,
    nextAt: session.nextAt,
    error: null,
    lastSettings: { ...lastSettings }
  };
}

function inactiveState(tabId) {
  return {
    active: false,
    ...lastSettings,
    remaining: 0,
    cycleDuration: 0,
    reloads: 0,
    startedAt: null,
    nextAt: null,
    error: lastErrors.get(tabId) || null,
    lastSettings: { ...lastSettings }
  };
}

async function startSession(tabId, rawSettings) {
  const id = toTabId(tabId);
  if (id === null) return { ok: false, error: t("errorInvalidTab") };

  await ready;

  const problem = await ensureReloadable(id);
  if (problem) {
    lastErrors.set(id, problem);
    await setBadge(id, "!", ERROR_COLOR);
    return { ok: false, error: problem };
  }

  const settings = normalizeSettings(rawSettings);
  const previous = sessions.get(id);
  const now = Date.now();

  const session = {
    tabId: id,
    ...settings,
    startedAt: previous ? previous.startedAt : now,
    reloads: previous ? previous.reloads : 0,
    active: true,
    nextAt: now,
    cycleStartAt: now,
    currentDelay: 0,
    lastBadge: null,
    reloading: false
  };

  lastErrors.delete(id);
  sessions.set(id, session);

  await rememberSettings(settings);
  scheduleNext(session, now);

  session.lastBadge = formatBadge(session.currentDelay);
  await setBadge(id, session.lastBadge, SESSION_COLOR);
  await setTabTitle(id, sessionTitle(session));

  return { ok: true, state: sessionState(session) };
}

async function stopSession(tabId) {
  const id = toTabId(tabId);
  if (id === null) return { ok: false, error: t("errorInvalidTab") };

  sessions.delete(id);
  lastErrors.delete(id);
  await clearBadge(id);
  await setTabTitle(id, t("extensionName"));

  return { ok: true, state: inactiveState(id) };
}

async function handleDueSession(session) {
  if (session.reloading) return;
  session.reloading = true;

  try {
    await browser.tabs.reload(session.tabId, {
      bypassCache: session.bypassCache
    });

    session.reloads += 1;
    lastErrors.delete(session.tabId);
    scheduleNext(session);

    session.lastBadge = formatBadge(session.currentDelay);
    await setBadge(session.tabId, session.lastBadge, SESSION_COLOR);
  } catch (error) {
    console.warn("Auto Refresh Plus: yenileme başarısız", error);
    const message = friendlyError(error);
    lastErrors.set(session.tabId, message);
    sessions.delete(session.tabId);

    await setBadge(session.tabId, "!", ERROR_COLOR);
    await setTabTitle(session.tabId, t("titleFailed"));
  } finally {
    session.reloading = false;
  }
}

async function refreshNow(tabId, bypassCache) {
  const id = toTabId(tabId);
  if (id === null) return { ok: false, error: t("errorInvalidTab") };

  await ready;

  const currentSession = sessions.get(id);
  if (currentSession && currentSession.reloading) {
    return { ok: true };
  }

  const problem = await ensureReloadable(id);
  if (problem) {
    lastErrors.set(id, problem);
    await setBadge(id, "!", ERROR_COLOR);
    return { ok: false, error: problem };
  }

  try {
    await browser.tabs.reload(id, {
      bypassCache:
        typeof bypassCache === "boolean"
          ? bypassCache
          : currentSession
            ? currentSession.bypassCache
            : lastSettings.bypassCache
    });

    lastErrors.delete(id);

    if (currentSession) {
      currentSession.reloads += 1;
      scheduleNext(currentSession);
      currentSession.lastBadge = formatBadge(currentSession.currentDelay);
      await setBadge(id, currentSession.lastBadge, SESSION_COLOR);
      await setTabTitle(id, sessionTitle(currentSession));
    }

    return { ok: true };
  } catch (error) {
    const message = friendlyError(error);
    lastErrors.set(id, message);
    sessions.delete(id);
    await setBadge(id, "!", ERROR_COLOR);
    await setTabTitle(id, t("titleFailed"));
    return { ok: false, error: message };
  }
}

async function getState(tabId) {
  const id = toTabId(tabId);
  await ready;

  if (id === null) {
    return {
      active: false,
      ...lastSettings,
      remaining: 0,
      cycleDuration: 0,
      reloads: 0,
      startedAt: null,
      nextAt: null,
      error: t("errorInvalidTab"),
      lastSettings: { ...lastSettings }
    };
  }

  const session = sessions.get(id);
  return session ? sessionState(session) : inactiveState(id);
}

async function toggleForTab(tabId) {
  await ready;

  if (sessions.has(tabId)) {
    return stopSession(tabId);
  }

  return startSession(tabId, { ...lastSettings });
}

/* ------------------------------------------------------------------ */
/* Zamanlayıcı                                                         */
/* ------------------------------------------------------------------ */

setInterval(() => {
  const now = Date.now();

  for (const session of Array.from(sessions.values())) {
    if (!session.active || session.reloading) continue;

    if (now >= session.nextAt) {
      void handleDueSession(session);
      continue;
    }

    const remaining = Math.max(1, Math.ceil((session.nextAt - now) / 1000));
    const text = formatBadge(remaining);

    if (text !== session.lastBadge) {
      session.lastBadge = text;
      void setBadge(session.tabId, text, SESSION_COLOR);
    }
  }
}, TICK_MS);

/* ------------------------------------------------------------------ */
/* Mesajlar                                                            */
/* ------------------------------------------------------------------ */

browser.runtime.onMessage.addListener((message) => {
  if (!message || typeof message.type !== "string") return undefined;
  if (!message.type.startsWith("arp:")) return undefined;

  switch (message.type) {
    case "arp:get-state":
      return getState(message.tabId);

    case "arp:start":
      return startSession(message.tabId, message.settings);

    case "arp:stop":
      return stopSession(message.tabId);

    case "arp:refresh-now":
      return refreshNow(message.tabId, message.bypassCache);

    default:
      return undefined;
  }
});

/* ------------------------------------------------------------------ */
/* Klavye kısayolu                                                     */
/* ------------------------------------------------------------------ */

browser.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-auto-refresh") return;

  try {
    const tab = await getActiveTab();
    if (!tab || !Number.isInteger(tab.id)) return;

    if (sessions.has(tab.id)) {
      await stopSession(tab.id);
    } else {
      await startSession(tab.id, { ...lastSettings });
    }
  } catch (error) {
    console.warn("Auto Refresh Plus: kısayol hatası", error);
  }
});

/* ------------------------------------------------------------------ */
/* Araç çubuğu simgesine sağ tık menüsü                                */
/* ------------------------------------------------------------------ */

async function buildMenus() {
  await ready;

  try {
    await browser.menus.removeAll();
  } catch (error) {
    /* Menüler zaten temiz olabilir. */
  }

  await browser.menus.create({
    id: MENU_TOGGLE,
    title: t("menuToggle"),
    contexts: ["browser_action"]
  });

  await browser.menus.create({
    id: MENU_NOW,
    title: t("menuRefreshNow"),
    contexts: ["browser_action"]
  });

  await browser.menus.create({
    id: MENU_PRESETS,
    title: t("menuStartWith"),
    contexts: ["browser_action"]
  });

  for (const seconds of MENU_INTERVALS) {
    await browser.menus.create({
      id: `${MENU_START_PREFIX}${seconds}`,
      parentId: MENU_PRESETS,
      title: formatDuration(seconds),
      contexts: ["browser_action"]
    });
  }
}

browser.menus.onClicked.addListener(async (info, tab) => {
  if (!tab || !Number.isInteger(tab.id)) return;
  const menuId = String(info.menuItemId);

  try {
    if (menuId === MENU_NOW) {
      await refreshNow(tab.id);
      return;
    }

    if (menuId === MENU_TOGGLE) {
      await toggleForTab(tab.id);
      return;
    }

    if (menuId.startsWith(MENU_START_PREFIX)) {
      const seconds = clampInt(
        menuId.slice(MENU_START_PREFIX.length),
        MIN_INTERVAL,
        MAX_INTERVAL,
        lastSettings.interval
      );
      await startSession(tab.id, {
        ...lastSettings,
        mode: "fixed",
        interval: seconds
      });
    }
  } catch (error) {
    console.warn("Auto Refresh Plus: menü hatası", error);
  }
});

/* ------------------------------------------------------------------ */
/* Yaşam döngüsü                                                       */
/* ------------------------------------------------------------------ */

browser.tabs.onRemoved.addListener((tabId) => {
  sessions.delete(tabId);
  lastErrors.delete(tabId);
});

browser.runtime.onInstalled.addListener(() => {
  void buildMenus();
});

browser.runtime.onStartup.addListener(() => {
  void buildMenus();
});

void buildMenus().catch((error) => {
  console.warn("Auto Refresh Plus: menüler oluşturulamadı", error);
});
