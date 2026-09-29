import { loadConfig, syncAll } from './sync.js';

const ALARM = 'gphotos-sync';
let running = false;

async function scheduleAlarm() {
  const { settings } = await loadConfig();
  await chrome.alarms.clear(ALARM);
  const period = Number(settings.intervalMinutes);
  if (period > 0) chrome.alarms.create(ALARM, { delayInMinutes: 1, periodInMinutes: Math.max(period, 5) });
}

async function runScheduled() {
  if (running) return;
  running = true;
  // Any extension API call resets the service worker idle timer during long transfers.
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20_000);
  try {
    await syncAll({ log: (m) => console.log('[sync]', m) });
  } finally {
    clearInterval(keepAlive);
    running = false;
  }
}

chrome.runtime.onInstalled.addListener(scheduleAlarm);
chrome.runtime.onStartup.addListener(scheduleAlarm);
chrome.storage.onChanged.addListener((changes) => {
  if (changes.settings) scheduleAlarm();
});
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) runScheduled();
});

chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL('app.html');
  const [existing] = await chrome.tabs.query({ url });
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
});
