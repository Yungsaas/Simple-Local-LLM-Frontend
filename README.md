**[Read this in Russian ↓](#russian)**
 
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
 
Download and install [Ollama](https://ollama.com) (via the app or the command line), then pull at least one model.
 
By default, Ollama blocks web pages from talking to it (a CORS restriction), which stops this app from reaching it even once it's running. You need to set the `OLLAMA_ORIGINS` environment variable to `*` to allow this.
 
There are two ways to do this: **temporarily** (only lasts until you close the terminal/restart your computer, needs to be redone each time) or **permanently** (set once, survives restarts). Instructions for both are below.
 
#### Temporary (do this each time you want to use the app)
 
**Windows** (Command Prompt):
```cmd
taskkill /F /IM "ollama app.exe" /T
taskkill /F /IM ollama.exe /T
set OLLAMA_ORIGINS=*
ollama serve
```
The two `taskkill` commands close any already-running copy of Ollama first, since it starts automatically on login and otherwise blocks the port. Leave the resulting window open while you use the chat app; closing it stops Ollama.
 
**Mac** (Terminal):
```bash
killall Ollama
OLLAMA_ORIGINS=* ollama serve
```
Same idea: this closes the running Ollama app first, then restarts it with the setting applied. Leave the terminal window open while you use the chat app.
 
#### Permanent (set once, no need to repeat)
 
**Windows:**
1. Press `Win`, search for **"Edit the system environment variables"**, and open it.
2. Click **Environment Variables…**
3. Under **User variables**, click **New…**
4. Variable name: `OLLAMA_ORIGINS`, Variable value: `*`
5. Click OK on all dialogs.
6. Quit Ollama completely (right-click its icon in the system tray → Quit) and reopen it. It will now always start with this setting, including after a reboot.
**Mac:**
Run this once in Terminal:
```bash
mkdir -p ~/Library/LaunchAgents
cat > ~/Library/LaunchAgents/setenv.OLLAMA_ORIGINS.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>setenv.OLLAMA_ORIGINS</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/launchctl</string>
    <string>setenv</string>
    <string>OLLAMA_ORIGINS</string>
    <string>*</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
EOF
launchctl load ~/Library/LaunchAgents/setenv.OLLAMA_ORIGINS.plist
```
This applies the setting immediately and also every time you log in from now on. Quit Ollama (`killall Ollama`) and reopen it once for it to take effect.
 
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
 
---
 
<a id="russian"></a>
 
## 🇷🇺 Русская версия
 
# Simple-Local-LLM-Frontend
Простой локальный фронтенд для LLM без излишеств. Всё, что касается ваших чатов и переписок, обрабатывается локально, включая работу инструмента веб-браузинга. Не нужны никакие API или сторонние входы. На данный момент поддерживается только Ollama.
 
## Возможности
- Подход «конфиденциальность прежде всего»: всё работает на вашем локальном компьютере.
- Регистрируйте несколько моделей Ollama и переключайтесь между ними через выпадающее меню в правом верхнем углу
- Сравнивайте две модели бок о бок на одном и том же запросе (одновременно или по очереди)
- Пресеты инструкций и опциональные системные промпты, которые можно выбирать для каждого чата
- Тёмная тема
- Настраиваемая интенсивность рассуждений для моделей с рассуждением
- Ограничение максимальной длины ответа, чтобы зациклившаяся модель не работала бесконечно
- Поиск по Википедии, доступный «из коробки» без какой-либо настройки
- Опциональный веб-поиск и загрузка страниц в реальном времени через прокси, который вы запускаете сами
- Сохраняйте чаты в локальный файл или используйте экспорт/импорт — на ваш выбор
## Требования
- [Ollama](https://ollama.com), установленная и запущенная локально, с хотя бы одной загруженной моделью
- (Опционально) Python 3, если вы хотите включить веб-поиск в реальном времени, см. [Шаг 3](#3-опционально-веб-доступ-для-llm-с-поддержкой-инструментов)
- (Опционально) Браузер на базе Chromium (Chrome, Edge, Brave, Opera), если вы хотите сохранять чаты в локальную папку, см. [Шаг 5](#5-опционально-локальная-папка-для-сохранения)
## Настройка
 
### 1. Установите Ollama и модель
 
Скачайте и установите [Ollama](https://ollama.com) (через приложение или командную строку), затем загрузите хотя бы одну модель.
 
По умолчанию Ollama блокирует обращения к ней со стороны веб-страниц (ограничение CORS), что мешает этому приложению связаться с ней даже после запуска. Чтобы это разрешить, нужно задать переменной окружения `OLLAMA_ORIGINS` значение `*`.
 
Сделать это можно двумя способами: **временно** (действует, пока вы не закроете терминал / не перезагрузите компьютер, нужно повторять каждый раз) или **постоянно** (задаётся один раз, сохраняется после перезагрузок). Инструкции для обоих способов приведены ниже.
 
#### Временно (делайте это каждый раз, когда хотите пользоваться приложением)
 
**Windows** (командная строка):
```cmd
taskkill /F /IM "ollama app.exe" /T
taskkill /F /IM ollama.exe /T
set OLLAMA_ORIGINS=*
ollama serve
```
Две команды `taskkill` сначала закрывают уже запущенную копию Ollama, поскольку она стартует автоматически при входе в систему и иначе занимает порт. Оставьте открытым появившееся окно, пока пользуетесь приложением; его закрытие остановит Ollama.
 
**Mac** (терминал):
```bash
killall Ollama
OLLAMA_ORIGINS=* ollama serve
```
То же самое: сначала закрывается запущенное приложение Ollama, затем оно перезапускается с применённой настройкой. Оставьте окно терминала открытым, пока пользуетесь приложением.
 
#### Постоянно (задаётся один раз, повторять не нужно)
 
**Windows:**
1. Нажмите `Win`, найдите **«Изменение системных переменных среды»** и откройте это окно.
2. Нажмите **«Переменные среды…»**
3. В разделе **«Переменные среды пользователя»** нажмите **«Создать…»**
4. Имя переменной: `OLLAMA_ORIGINS`, значение переменной: `*`
5. Нажмите OK во всех диалоговых окнах.
6. Полностью закройте Ollama (правый клик по значку в системном трее → «Выход») и откройте её заново. Теперь она всегда будет запускаться с этой настройкой, в том числе после перезагрузки.
**Mac:**
Выполните это один раз в терминале:
```bash
mkdir -p ~/Library/LaunchAgents
cat > ~/Library/LaunchAgents/setenv.OLLAMA_ORIGINS.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>setenv.OLLAMA_ORIGINS</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/launchctl</string>
    <string>setenv</string>
    <string>OLLAMA_ORIGINS</string>
    <string>*</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
EOF
launchctl load ~/Library/LaunchAgents/setenv.OLLAMA_ORIGINS.plist
```
Эта команда применяет настройку немедленно, а также при каждом последующем входе в систему. Закройте Ollama (`killall Ollama`) и один раз откройте её заново, чтобы изменения вступили в силу.
 
- Если вы хотите, чтобы модель использовала поиск по Википедии или веб-поиск, она должна поддерживать **вызов инструментов/функций** (tool/function calling) — это возможность конкретной модели в Ollama, а не то, что может добавить это приложение или прокси. Такие модели, как Llama 3.1+, Qwen 2.5+/3, Gemma 4 и Mistral Nemo, поддерживают её; некоторые более мелкие или старые модели — нет, и они просто проигнорируют инструменты, если их об этом попросить.
### 2. Откройте HTML-файл и настройте параметры
- `gemma4:e4b` — модель по умолчанию, и её следует удалить, если вы её не используете
- Вы можете зарегистрировать несколько моделей и легко переключаться между ними через выпадающее меню в правом верхнем углу
- Вы можете сравнивать модели бок о бок на одном и том же запросе, если они зарегистрированы; по умолчанию сравнение идёт одновременно, либо по очереди, если вы предпочитаете не загружать две модели в память сразу (лучше, если у вашей машины меньше RAM/VRAM)
- URL сервера Ollama следует менять только если вы изменили настройки внутри самой Ollama; он уже задан на значение по умолчанию для Ollama (`http://localhost:11434`)
- **Тёмную тему** можно включить в боковой панели
- **Интенсивность рассуждений** (Off / Low / Medium / High / Max) определяет, насколько усердно способные к рассуждению модели думают перед ответом; обратите внимание, что Max — более новая опция и может не распознаваться старыми версиями Ollama или некоторыми моделями
- **Максимальная длина ответа** задаёт жёсткий лимит токенов на рассуждение и ответ вместе взятые — полезно как страховка, если модель начинает зацикливаться
### 3. (Опционально) Веб-доступ [для LLM с поддержкой инструментов]
Все LLM получают инструмент **поиска по Википедии** без какой-либо настройки, без прокси, всегда доступный для надёжных справочных/энциклопедических ответов.
 
Для полноценного веб-поиска и загрузки страниц в реальном времени вы можете запустить небольшой локальный прокси:
- `local_cors_proxy.py` — это скрипт, который этим занимается
- Меняйте настройку CORS-прокси в приложении только если вы изменили порт, на котором работает прокси
- Запускайте его через файл `.bat` (Windows) или `.command` (Mac: в первый раз щёлкните правой кнопкой и выберите «Открыть»; после этого двойной клик работает как обычно)
- При запуске он спросит, сколько минут бездействия ждать перед автоматической остановкой; нажмите Enter для значения по умолчанию (30) или введите `0`, чтобы полностью отключить авто-остановку и оставить прокси работать, пока вы его не закроете
### 4. (Опционально) Пресеты инструкций
Задайте вашей LLM постоянные инструкции о том, как ей отвечать на ваши запросы.
- Пресеты добавляются из меню настроек
- Вы можете выбрать пресет для каждого чата из выпадающего меню в верхней панели
### 5. (Опционально) Локальная папка для сохранения
Сохраняйте чаты в настоящий файл на диске, а не только во внутреннем хранилище браузера.
- Поддерживается в Chrome, Edge, Brave и Opera (браузеры на базе Chromium). **Не поддерживается в Firefox и Safari** — ни у одного из них нет такой возможности, и обходного пути не существует.
- Это записывает файл `chats.json` в выбранную вами папку. Если вы подключите ту же папку с другого устройства или браузера, приложение автоматически объединит данные, а не перезапишет какие-либо из них.
- В неподдерживаемых браузерах такая настройка просто невозможна, но ваши чаты всё равно сохраняются во внутреннем хранилище браузера, так что вы ничего не потеряете, если только не очистите данные браузера.
### 6. (Опционально) Экспорт и импорт чатов
Запасной вариант, если вы не хотите (или не можете) сохранять в локальный файл, но всё же хотите сделать резервную копию или перенести свои чаты.
- Экспорт создаёт `.json`-файл с датой; импорт объединяет его с вашими существующими чатами, а не перезаписывает их, поэтому повторный импорт одного и того же файла дважды безопасен
- Если вы уже сохраняете в локальный файл, эта опция отключена, поскольку всё уже сохраняется там
## Замечание о слове «локальный»
Ваши переписки с Ollama никогда не покидают ваш компьютер. Сама страница чата всё же загружает несколько библиотек для отображения (Markdown/KaTeX/санитизация) с CDN, поэтому ей нужен доступ в интернет один раз при загрузке, но никакие данные чатов никогда никуда не отправляются в рамках этого процесса.
