# MacClippy 📎

A nostalgic desktop paperclip for macOS. It sits in a corner, **scoots away when your cursor gets close**, blinks, makes quips, runs reminders, and — the fun part — **watches your screen with a local Gemma model** and pops a helpful tip ("It looks like you left the Email field blank…"). Click it (or hit a hotkey) to ask questions. It can optionally **glance at your webcam** and react. A menu-bar 📎 button shows/hides/quits it, and it can launch at login as a proper **MacClippy.app**.

Everything AI runs **locally** through [Ollama](https://ollama.com) — screenshots and webcam frames are processed on your machine and never leave it.

It's two halves:
- **Service** (Electron main process): screenshots, Gemma calls, reminders, cursor-evasion, webcam, hotkey, menu bar, login item.
- **Frontend** (Electron renderer): the animated paperclip with googly eyes, speech bubbles, and a chat box.

---

## Requirements

- **macOS**
- **Node.js 18+** — check with `node -v`
- **Ollama** running locally with a **multimodal Gemma 3** model pulled

### About the model
Gemma understands screenshots — but only the multimodal sizes. MacClippy defaults to **`gemma4:latest`**, which is already installed on this machine and is multimodal (vision).

- `gemma4:latest` — default, already installed here. 8B, multimodal. ✅ vision
- `gemma3:4b` / `12b` / `27b` — Gemma 3's vision variants also work. ✅ vision
- `gemma:2b`, `gemma2`, `gemma3:1b` — **text-only**, can't see screenshots.

One model covers everything: screen tips, chat answers, and webcam reactions.

---

## Quick start

```bash
cd ~/Code/MacClippy
npm install
ollama pull gemma4         # already installed here; any vision-capable Gemma works
npm start
```

The 📎 appears in your menu bar and Clippy parks in the top-right corner.

### Build a real MacClippy.app (named wrapper + clean login item)
```bash
npm run dist        # builds dist/MacClippy-<version>.dmg and a .zip
```
Open the DMG, drag **MacClippy.app** to /Applications, launch it once. Now it shows as "MacClippy" everywhere and, with *Open at login* on, starts automatically and hidden at boot. (Running `npm start` works too, but the login-item path is cleanest when packaged.)

### Permissions (one time)
- **Screen Recording** — System Settings → Privacy & Security → Screen Recording → enable MacClippy (or your terminal/IDE if running via `npm start`). Without it, screen tips come back blank.
- **Camera** — only prompted if you turn on webcam glances.

---

## Using it

**Menu bar 📎** — the button at the top of the screen:
- **Show / Hide Clippy**, **Summon** (pulls him to center and stops the fleeing so you can interact)
- **Ask Clippy something…**, **Look at my screen now**
- **Webcam glances (Clippy sees you)** toggle, **Let Clippy see me now**
- **Choose avatar… / Use default paperclip**
- **Open at login** toggle, edit settings, **Quit**

**Talk to Clippy** — click the paperclip, or press the global hotkey **⌘⇧C** (configurable) from any app. It summons him to center and toggles the chat box. Your current screen is sent along for context. Press the hotkey again (or Esc) to close.

**He runs away** from your cursor by design — use **Summon** / the hotkey, or turn off *Evade my cursor*, when you want to grab him.

**Custom avatar** — *Choose avatar…* and pick any PNG / GIF / SVG (animated GIFs work great). Eye-tracking applies to the built-in paperclip only.

---

## Configuration — `config.json`

| Key | What it controls |
|---|---|
| `avatar.type` / `avatar.image` | `builtin` paperclip, or `image` + a path to your own. |
| `startup.openAtLogin` | Launch automatically at login (best with the packaged app). |
| `shortcuts.toggleTalk` | Global hotkey to summon + toggle chat. Default `CommandOrControl+Shift+C`. |
| `ollama.model` / `ollama.host` | Which Gemma model and where Ollama lives. |
| `watch.enabled` / `watch.intervalMinutes` | Screen-watching on/off and frequency (default 4 min). |
| `webcam.enabled` / `webcam.intervalMinutes` | Opt-in webcam glances (default **off**). |
| `evasion.homeCorner` / `fleeRadiusPx` / `pushStepPx` | Where he parks and how skittish he is. |
| `reminders.hydrationMinutes` / `postureMinutes` | Set `0` to disable; flip `pomodoro.enabled` for focus cycles. |
| `idleQuips.enabled` | Classic random one-liners. |

> Note on the hotkey: macOS doesn't expose the **fn** key to apps, so it can't be used as a global accelerator. Use modifiers like `Command`, `Control`, `Option`, `Shift` + a key.

---

## Privacy

- Screen and webcam frames are sent **only** to your local Ollama instance (`localhost`). Nothing is uploaded anywhere.
- Webcam glances are **off by default**. When on, the camera opens just long enough to grab one frame, then turns off (the camera light blinks as a visible tell).

---

## Troubleshooting

- **Blank/no screen tips** → grant Screen Recording permission.
- **"I couldn't reach Gemma…"** → `ollama serve` not running, or model not pulled (`ollama list`).
- **Won't stop running away** → menu 📎 → uncheck *Evade my cursor*, or press the hotkey / **Summon**.
- **Hotkey does nothing** → another app may own that combo; change `shortcuts.toggleTalk`.
- **Can't see him** → menu 📎 → **Show Clippy**.

---

## Project layout

```
MacClippy/
├── main.js            # service: menu bar, screenshots, Gemma, webcam, hotkey, evasion, login item
├── preload.js         # safe IPC bridge
├── renderer/
│   └── index.html     # animated paperclip + speech bubble + chat box
├── config.json        # all settings
├── build/icon.png     # app icon
├── package.json       # scripts + electron-builder config
├── LICENSE            # MIT
└── README.md
```
