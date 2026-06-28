// MacClippy — main process (the "service")
// Responsibilities:
//   * menu bar (Tray) button: Show / Hide / Summon / Quit  -> the "button at the top of the screen"
//   * transparent, always-on-top, draggable overlay window that hosts the animated paperclip
//   * sits in a corner and SCOOTS AWAY when the cursor gets near (global cursor polling)
//   * periodically screenshots the screen and asks local Gemma (via Ollama) for a helpful tip
//   * reminder timers (hydration, posture, optional pomodoro) + time-aware greeting
//   * click-to-ask: renderer sends a question, main asks Gemma (with optional screenshot), returns answer

const {
  app, BrowserWindow, Tray, Menu, screen,
  desktopCapturer, ipcMain, nativeImage, systemPreferences, shell, dialog, session, globalShortcut,
} = require('electron');

app.setName('MacClippy');
const fs = require('fs');
const path = require('path');

// ---------- config ----------
const DEFAULTS = {
  avatar: { type: 'builtin', image: '', eyesTrackCursor: true },
  startup: { openAtLogin: true },
  shortcuts: { toggleTalk: 'CommandOrControl+Shift+C' },
  ollama: { host: 'http://localhost:11434', model: 'gemma3:4b', timeoutMs: 45000 },
  watch: { enabled: true, intervalMinutes: 4, screenshotMaxWidth: 1280, screenshotMaxHeight: 800 },
  webcam: { enabled: false, intervalMinutes: 12 },
  evasion: { enabled: true, homeCorner: 'top-right', fleeRadiusPx: 160, pushStepPx: 36, returnEasing: 0.08, pollMs: 110 },
  reminders: { greetOnLaunch: true, hydrationMinutes: 50, postureMinutes: 30, pomodoro: { enabled: false, workMinutes: 25, breakMinutes: 5 } },
  idleQuips: { enabled: true, everyMinutesMin: 6, everyMinutesMax: 14 },
};

function loadConfig() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8');
    return deepMerge(DEFAULTS, JSON.parse(raw));
  } catch (e) {
    console.warn('[MacClippy] config.json not found or invalid, using defaults:', e.message);
    return DEFAULTS;
  }
}
function deepMerge(base, over) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const k of Object.keys(over || {})) {
    if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k])) {
      out[k] = deepMerge(base[k] || {}, over[k]);
    } else {
      out[k] = over[k];
    }
  }
  return out;
}

const CFG = loadConfig();
const CONFIG_PATH = path.join(__dirname, 'config.json');

function saveConfig() {
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(CFG, null, 2)); }
  catch (e) { console.warn('[MacClippy] could not save config:', e.message); }
}

// ---------- avatar ----------
const MIME = { '.png': 'image/png', '.gif': 'image/gif', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' };

// Resolve the avatar into something the renderer can show directly.
// Built-in -> the drawn paperclip. Image -> a data URL (avoids file:// permission quirks).
function resolveAvatar() {
  const a = CFG.avatar || {};
  if (a.type === 'image' && a.image) {
    try {
      let p = a.image;
      if (!path.isAbsolute(p)) p = path.join(__dirname, p);
      const ext = path.extname(p).toLowerCase();
      const mime = MIME[ext] || 'image/png';
      const buf = fs.readFileSync(p);
      return { mode: 'image', dataUrl: `data:${mime};base64,${buf.toString('base64')}`, eyesTrackCursor: false };
    } catch (e) {
      console.warn('[MacClippy] avatar image not loadable, falling back to paperclip:', e.message);
    }
  }
  return { mode: 'builtin', dataUrl: null, eyesTrackCursor: a.eyesTrackCursor !== false };
}

function chooseAvatar() {
  const res = dialog.showOpenDialogSync({
    title: 'Pick a MacClippy avatar',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'gif', 'jpg', 'jpeg', 'webp', 'svg'] }],
  });
  if (res && res[0]) {
    CFG.avatar.type = 'image';
    CFG.avatar.image = res[0];
    saveConfig();
    if (win) win.webContents.reload();
    speak("New look! How do I look?", 'tip');
  }
}

function useDefaultAvatar() {
  CFG.avatar.type = 'builtin';
  CFG.avatar.image = '';
  saveConfig();
  if (win) win.webContents.reload();
  speak("Back to the classic paperclip.", 'tip');
}

// ---------- window geometry ----------
const WIN_W = 300;
const WIN_H = 320;

let win = null;
let tray = null;
let evasionEnabled = CFG.evasion.enabled;
let webcamEnabled = CFG.webcam.enabled;
let webcamTimer = null;
let summoned = false;          // when summoned, stop fleeing so the user can interact
let pointerOverClippy = false; // renderer tells us when the cursor is on an interactive part
let chatting = false;          // pause fleeing while the chat box is open
const timers = [];

function cornerHome(displayWorkArea) {
  const wa = displayWorkArea;
  const m = 24; // margin from screen edge
  switch (CFG.evasion.homeCorner) {
    case 'top-left':     return { x: wa.x + m,                 y: wa.y + m };
    case 'bottom-left':  return { x: wa.x + m,                 y: wa.y + wa.height - WIN_H - m };
    case 'bottom-right': return { x: wa.x + wa.width - WIN_W - m, y: wa.y + wa.height - WIN_H - m };
    case 'top-right':
    default:             return { x: wa.x + wa.width - WIN_W - m, y: wa.y + m };
  }
}

function createWindow() {
  const primary = screen.getPrimaryDisplay();
  const home = cornerHome(primary.workArea);

  win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    x: home.x,
    y: home.y,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    fullscreenable: false,
    alwaysOnTop: true,
    focusable: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Start click-through; renderer flips this off when the cursor is over Clippy or the bubble.
  win.setIgnoreMouseEvents(true, { forward: true });

  win.once('ready-to-show', () => {
    win.showInactive(); // appear without stealing focus
    if (CFG.reminders.greetOnLaunch) {
      setTimeout(() => speak(greeting(), 'greeting'), 1200);
    }
  });
}

// ---------- menu bar (top of screen) ----------
function createTray() {
  // Use an empty image + an emoji title so we don't need an icon asset file.
  tray = new Tray(nativeImage.createEmpty());
  tray.setTitle('📎');
  tray.setToolTip('MacClippy');
  rebuildTrayMenu();
  tray.on('click', () => tray.popUpContextMenu());
}

function rebuildTrayMenu() {
  const menu = Menu.buildFromTemplate([
    { label: win && win.isVisible() ? 'Hide Clippy' : 'Show Clippy', click: toggleVisible },
    { label: 'Summon Clippy (come here)', click: summon },
    { type: 'separator' },
    { label: 'Ask Clippy something…', click: () => { summon(); sendToRenderer('open-chat'); } },
    { label: 'Look at my screen now', click: () => runWatchOnce(true) },
    { type: 'separator' },
    { label: 'Evade my cursor', type: 'checkbox', checked: evasionEnabled, click: (mi) => { evasionEnabled = mi.checked; } },
    { type: 'separator' },
    { label: 'Webcam glances (Clippy sees you)', type: 'checkbox', checked: webcamEnabled, click: (mi) => {
        webcamEnabled = mi.checked; CFG.webcam.enabled = mi.checked; saveConfig();
        if (webcamEnabled) { startWebcamTimer(); triggerWebcamGlance(true); } else { stopWebcamTimer(); }
      } },
    { label: 'Let Clippy see me now', click: () => triggerWebcamGlance(true) },
    { type: 'separator' },
    { label: 'Choose avatar…', click: chooseAvatar },
    { label: 'Use default paperclip', click: useDefaultAvatar },
    { type: 'separator' },
    { label: 'Open at login', type: 'checkbox', checked: !!CFG.startup.openAtLogin, click: (mi) => {
        CFG.startup.openAtLogin = mi.checked; saveConfig(); applyLoginItem();
      } },
    { label: 'Edit settings (config.json)', click: () => shell.openPath(CONFIG_PATH) },
    { type: 'separator' },
    { label: 'Quit MacClippy', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
}

function toggleVisible() {
  if (!win) return;
  if (win.isVisible()) win.hide();
  else win.showInactive();
  rebuildTrayMenu();
}

function summon() {
  if (!win) return;
  summoned = true;
  const disp = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const wa = disp.workArea;
  const x = Math.round(wa.x + (wa.width - WIN_W) / 2);
  const y = Math.round(wa.y + (wa.height - WIN_H) / 2);
  anchor = { x, y };
  win.setPosition(x, y, true);
  win.setIgnoreMouseEvents(false);
  // Accessory (menu-bar) apps must actively activate to receive keystrokes.
  if (process.platform === 'darwin') app.focus({ steal: true });
  win.show();
  win.focus();
  win.webContents.focus();
  sendToRenderer('summoned');
  // Resume evasion after a grace period.
  setTimeout(() => { summoned = false; }, 8000);
  rebuildTrayMenu();
}

// ---------- evasion: dart to the farthest corner when the cursor approaches ----------
const CLIP_DX = 195; // x offset of the visible clip's center inside the window
const CLIP_DY = 198; // y offset of the visible clip's center inside the window
let anchor = null;   // where Clippy wants to rest right now

function evasionCandidates(wa) {
  const m = 24;
  return [
    { x: wa.x + m,                    y: wa.y + m },                     // top-left
    { x: wa.x + wa.width - WIN_W - m, y: wa.y + m },                     // top-right
    { x: wa.x + m,                    y: wa.y + wa.height - WIN_H - m },  // bottom-left
    { x: wa.x + wa.width - WIN_W - m, y: wa.y + wa.height - WIN_H - m },  // bottom-right
  ];
}

function glideTo(target) {
  if (!win || !target) return;
  const b = win.getBounds();
  const e = 0.3; // easing — higher = snappier dart
  const nx = b.x + (target.x - b.x) * e;
  const ny = b.y + (target.y - b.y) * e;
  if (Math.abs(nx - b.x) > 0.5 || Math.abs(ny - b.y) > 0.5) {
    win.setPosition(Math.round(nx), Math.round(ny));
  }
}

function startEvasionLoop() {
  anchor = cornerHome(screen.getPrimaryDisplay().workArea);
  const tick = () => {
    if (!win || !win.isVisible()) return;
    if (!evasionEnabled || summoned || chatting) return; // stay put when not evading
    const cursor = screen.getCursorScreenPoint();
    const wa = screen.getDisplayNearestPoint(cursor).workArea;
    const b = win.getBounds();
    const clipX = b.x + CLIP_DX;
    const clipY = b.y + CLIP_DY;
    const dist = Math.hypot(clipX - cursor.x, clipY - cursor.y);

    if (dist < CFG.evasion.fleeRadiusPx) {
      // cursor too close -> relocate to whichever corner is FARTHEST from the cursor (switch sides)
      let best = anchor, bestD = -1;
      for (const c of evasionCandidates(wa)) {
        const d = Math.hypot((c.x + CLIP_DX) - cursor.x, (c.y + CLIP_DY) - cursor.y);
        if (d > bestD) { bestD = d; best = c; }
      }
      anchor = best;
    }
    glideTo(anchor);
  };
  timers.push(setInterval(tick, CFG.evasion.pollMs));
}

// ---------- screen watching + Gemma ----------
async function captureScreenBase64() {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: CFG.watch.screenshotMaxWidth, height: CFG.watch.screenshotMaxHeight },
  });
  if (!sources.length) return null;
  const img = sources[0].thumbnail;
  if (img.isEmpty()) return null; // happens before Screen Recording permission is granted
  return img.toPNG().toString('base64');
}

async function callOllama(prompt, imagesB64) {
  const url = `${CFG.ollama.host}/api/generate`;
  const body = { model: CFG.ollama.model, prompt, stream: false };
  if (imagesB64 && imagesB64.length) body.images = imagesB64;

  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), CFG.ollama.timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
    const data = await res.json();
    return (data.response || '').trim();
  } finally {
    clearTimeout(to);
  }
}

const WATCH_PROMPT =
  "You are MacClippy, a friendly desktop assistant looking at a screenshot of the user's screen. " +
  "In ONE short sentence (max 20 words), point out the single most useful thing: a form field left blank, " +
  "an obvious next step, a likely mistake, or a small helpful tip. If nothing needs attention, reply exactly: NOTHING. " +
  "Be specific and kind. Do not describe the whole screen.";

async function runWatchOnce(force = false) {
  if (!force && !CFG.watch.enabled) return;
  try {
    sendToRenderer('thinking', true);
    const shot = await captureScreenBase64();
    if (!shot) {
      if (force) speak("I can't see your screen yet — grant Screen Recording permission in System Settings.", 'warn');
      return;
    }
    const tip = await callOllama(WATCH_PROMPT, [shot]);
    if (tip && tip.toUpperCase() !== 'NOTHING' && tip.length > 1) {
      speak(tip, 'tip');
    } else if (force) {
      speak("Looks good to me — nothing jumping out right now.", 'tip');
    }
  } catch (e) {
    console.warn('[MacClippy] watch error:', e.message);
    if (force) speak(`I couldn't reach Gemma (${e.message}). Is Ollama running?`, 'warn');
  } finally {
    sendToRenderer('thinking', false);
  }
}

function startWatchLoop() {
  if (!CFG.watch.enabled) return;
  const ms = Math.max(1, CFG.watch.intervalMinutes) * 60 * 1000;
  setTimeout(() => runWatchOnce(false), 15000); // first peek shortly after launch
  timers.push(setInterval(() => runWatchOnce(false), ms));
}

// ---------- webcam glances (opt-in) ----------
// The renderer grabs ONE frame (camera opens briefly, then stops), sends it here,
// and Gemma returns a warm one-liner. Frames never leave the machine.
const WEBCAM_PROMPT =
  "You are MacClippy looking at the user through their webcam. In ONE short, warm, lightly playful sentence " +
  "(max 16 words), react to their expression, posture, or vibe. Be kind and supportive; never comment negatively " +
  "on appearance and never be creepy. If you don't clearly see a person, reply exactly: NOTHING.";

function triggerWebcamGlance(force = false) {
  if (!force && !webcamEnabled) return;
  sendToRenderer('webcam-glance', { force: !!force });
}
function startWebcamTimer() {
  stopWebcamTimer();
  if (!webcamEnabled) return;
  const ms = Math.max(1, CFG.webcam.intervalMinutes) * 60 * 1000;
  webcamTimer = setInterval(() => triggerWebcamGlance(false), ms);
}
function stopWebcamTimer() {
  if (webcamTimer) { clearInterval(webcamTimer); webcamTimer = null; }
}

// ---------- global hotkey: toggle talk-to-Clippy from anywhere ----------
function registerShortcuts() {
  globalShortcut.unregisterAll();
  const accel = CFG.shortcuts && CFG.shortcuts.toggleTalk;
  if (!accel) return;
  const ok = globalShortcut.register(accel, () => sendToRenderer('toggle-chat'));
  if (!ok) console.warn('[MacClippy] could not register hotkey:', accel, '(already in use?)');
}

// ---------- login item ----------
function applyLoginItem() {
  try {
    app.setLoginItemSettings({ openAtLogin: !!CFG.startup.openAtLogin, openAsHidden: true });
  } catch (e) {
    console.warn('[MacClippy] could not set login item:', e.message);
  }
}

// ---------- reminders ----------
function greeting() {
  const h = new Date().getHours();
  if (h < 5)  return "Burning the midnight oil? I'm right here if you need me.";
  if (h < 12) return "Good morning! It looks like you're ready to be productive.";
  if (h < 18) return "Afternoon! Need a hand with anything?";
  if (h < 22) return "Good evening. Let's get things done.";
  return "It's getting late — I'll keep the tips short.";
}

function startReminders() {
  const r = CFG.reminders;
  if (r.hydrationMinutes > 0) {
    timers.push(setInterval(() => speak("Hydration check — go grab some water. 💧", 'reminder'), r.hydrationMinutes * 60 * 1000));
  }
  if (r.postureMinutes > 0) {
    timers.push(setInterval(() => speak("Posture check: sit up, shoulders back, unclench your jaw.", 'reminder'), r.postureMinutes * 60 * 1000));
  }
  if (r.pomodoro && r.pomodoro.enabled) {
    startPomodoro();
  }
}

function startPomodoro() {
  const p = CFG.reminders.pomodoro;
  let onBreak = false;
  const cycle = () => {
    if (onBreak) {
      speak("Break's over — back to it. You've got this.", 'reminder');
      onBreak = false;
      timers.push(setTimeout(cycle, p.workMinutes * 60 * 1000));
    } else {
      speak(`That's a ${p.workMinutes}-minute focus block done. Take a ${p.breakMinutes}-minute break!`, 'reminder');
      onBreak = true;
      timers.push(setTimeout(cycle, p.breakMinutes * 60 * 1000));
    }
  };
  timers.push(setTimeout(cycle, p.workMinutes * 60 * 1000));
}

// ---------- renderer messaging ----------
function sendToRenderer(channel, payload) {
  if (win && !win.isDestroyed() && win.webContents) {
    win.webContents.send(channel, payload);
  }
}
function speak(text, kind = 'tip') {
  if (!win) return;
  if (!win.isVisible()) win.showInactive();
  sendToRenderer('speak', { text, kind });
}

// ---------- IPC from renderer ----------
ipcMain.handle('ask', async (_evt, question) => {
  try {
    let images = [];
    try { const s = await captureScreenBase64(); if (s) images = [s]; } catch (_) {}
    const prompt =
      "You are MacClippy, a concise, friendly desktop assistant. A screenshot of the user's current screen is attached for context. " +
      "Answer the user's question in 1-3 short sentences. Question: " + question;
    const answer = await callOllama(prompt, images);
    return { ok: true, answer: answer || "Hmm, I didn't get anything back." };
  } catch (e) {
    return { ok: false, answer: `I couldn't reach Gemma (${e.message}). Is Ollama running with the model pulled?` };
  }
});

ipcMain.on('set-ignore-mouse', (_evt, ignore) => {
  pointerOverClippy = !ignore;
  if (win) win.setIgnoreMouseEvents(ignore, { forward: true });
});

ipcMain.on('chat-state', (_evt, isOpen) => { chatting = !!isOpen; });

ipcMain.on('look-now', () => runWatchOnce(true));

ipcMain.on('request-summon', () => summon());

ipcMain.handle('get-config', () => ({ avatar: resolveAvatar() }));

ipcMain.handle('webcam-comment', async (_evt, b64) => {
  try {
    const text = await callOllama(WEBCAM_PROMPT, [b64]);
    const clean = (text || '').trim();
    return { ok: true, text: clean && clean.toUpperCase() !== 'NOTHING' ? clean : '' };
  } catch (e) {
    return { ok: false, text: `I couldn't read the webcam (${e.message}).` };
  }
});

// ---------- lifecycle ----------
app.whenReady().then(() => {
  if (process.platform === 'darwin' && app.dock) app.dock.hide(); // menu-bar/overlay app, no dock icon

  // Allow the renderer to use the camera for opt-in webcam glances.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(permission === 'media');
  });

  applyLoginItem();

  // Friendly heads-up if Screen Recording permission isn't granted yet.
  if (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus) {
    const status = systemPreferences.getMediaAccessStatus('screen');
    if (status !== 'granted') {
      console.log('[MacClippy] Screen Recording not yet granted — screen tips will be blank until you allow it in System Settings > Privacy & Security > Screen Recording.');
    }
  }

  createWindow();
  createTray();
  startEvasionLoop();
  startWatchLoop();
  startReminders();
  startWebcamTimer();
  registerShortcuts();
});

app.on('will-quit', () => globalShortcut.unregisterAll());

app.on('window-all-closed', (e) => {
  // Keep running as a menu-bar app even if the window is hidden/closed.
  e.preventDefault();
});

app.on('before-quit', () => {
  timers.forEach((t) => { clearInterval(t); clearTimeout(t); });
});
