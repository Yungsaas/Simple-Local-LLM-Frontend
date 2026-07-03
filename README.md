# Simple-Local-LLM-Frontend
A simple local LLM frontend with no fancy features. Everything about your chats and conversations is handled locally, including web browsing tool access. No APIs or third-party sign-ins needed. Currently only supports Ollama.

## Features
- Privacy-first approach, everything runs on your local machine.
- Register multiple Ollama models and switch between them from a top-right dropdown
- Compare two models side-by-side on the same prompt (simultaneous or one-at-a-time)
- Instruction presets, optional system prompts you can pick per chat
- Dark mode
- Adjustable reasoning effort for thinking models
- Max response length cap, so a looping model can't run forever
- Wikipedia lookup, available out of the box with no setup
- Optional live web search / page fetching via a proxy you run yourself
- Save chats to a local file, or fall back to export/import, your choice

## Requirements
- [Ollama](https://ollama.com) installed and running locally, with at least one model pulled
- (Optional) Python 3 if you want to enable live web search, see [Step 3](#3-optional-web-access)
- (Optional) A Chromium-based browser (Chrome, Edge, Brave, Opera) if you want to save chats to a local folder, see [Step 5](#5-optional-local-save-folder)

## Set-Up

### 1. Install Ollama and a model
Download Ollama and install a local LLM of your choice.

After installing, on windows, run these commands to kill all ollama processes first: `taskkill /F /IM "ollama app.exe" /T` and `taskkill /F /IM ollama.exe /T`
then run `set OLLAMA_ORIGINS=*` to ensure the site can reach ollama
and finally serve ollama with `ollama serve`

After installing, on MAC, run
`killall Ollama`
and then
`OLLAMA_ORIGINS=* ollama serve`
to ensure the site can reach ollama

- If you want the model to use Wikipedia lookup or web search, it needs to support **tool/function calling**, this is a per-model capability in Ollama, not something this app or the proxy can add. Models like Llama 3.1+, Qwen 2.5+/3, Gemma 4, and Mistral Nemo support it; some smaller or older models don't, and will simply ignore the tools if asked.

### 2. Open the HTML file and configure settings
- `gemma4:e4b` is the default model and should be removed if you're not using it
- You can register multiple models and switch between them easily using the top-right dropdown
- You can compare models side-by-side on the same prompt if they've been registered, runs simultaneously by default, or one-at-a-time if you'd rather not load two models into memory at once (better if your machine has less ram/vram)
- The Ollama server URL should only be changed if you've changed your settings within Ollama itself, it's already set to Ollama's default (`http://localhost:11434`)
- **Dark mode** can be toggled from the sidebar
- **Reasoning effort** (Off / Low / Medium / High / Max) controls how hard thinking-capable models reason before answering, note that Max is a newer option and may not be recognized by older Ollama versions or by every model
- **Max response length** sets a hard token cap across thinking + reply combined, useful as a safety net if a model starts looping

### 3. (Optional) Web access [for LLMs that support tools]
All LLMs get the **Wikipedia lookup** tool with no setup, no proxy, always available for reliable reference/encyclopedic answers.

For general **live web search and page fetching**, you can run a small local proxy:
- `local_cors_proxy.py` is the script that handles this
- Only change the CORS proxy setting in the app if you changed the port the proxy runs on
- Run it via the `.bat` (Windows) or the `.command` file (Mac: right-click and choose "Open" the first time; after that, double-clicking works normally)
- On startup, it'll ask how many minutes of inactivity to wait before automatically stopping, press Enter for the default (30), or enter `0` to disable auto-stop entirely and let it run until you close it

### 4. (Optional) Instruction presets
Give your LLM standing instructions on how it should respond to your prompts.
- Presets are added from the settings menu
- You can pick a preset per chat from the dropdown in the top bar

### 5. (Optional) Local save folder
Save your chats to a real file on disk instead of only the browser's own storage.
- Supported in Chrome, Edge, Brave, and Opera (Chromium-based browsers). **Not supported in Firefox or Safari**, neither has this capability, and there's no workaround.
- This writes a `chats.json` file to a folder you choose. If you reconnect that same folder from another device or browser, the app merges the two automatically rather than overwriting either.
- On unsupported browsers, this setup just isn't possible, but your chats are still saved in the browser's own storage, so you won't lose anything unless you clear your browser data.

### 6. (Optional) Exporting and importing chats
A fallback if you don't want to (or can't) save to a local file, but still want to back up or transfer your chats.
- Export produces a dated `.json` file; importing merges it into your existing chats rather than overwriting them, so re-importing the same file twice is safe
- If you're already saving to a local file, this option is disabled, since everything is already saved there

## A note on "local"
Your conversations with Ollama never leave your machine. The chat page itself does load a few rendering libraries (Markdown/KaTeX/sanitization) from a CDN, so it needs internet access once to load, but no chat data is ever sent anywhere as part of that.
