// --- Settings modal ---
function showSettingsMessage(msg, isError){
  document.getElementById('settingsError').innerHTML = msg
    ? `<div class="${isError ? 'error-banner' : 'info-banner'}">${escapeHtml(msg)}</div>`
    : '';
}

// Model registry and instruction presets are mutated immediately as the
// user edits them in the modal (unlike baseUrl/thinkLevel/etc., which only
// commit on Save), this snapshot lets Cancel revert those immediate edits
// too, so "Cancel" means the same thing for every field in the dialog.
// Local-save-file connect/disconnect is intentionally NOT part of this
// revert: it has real filesystem/permission side effects that shouldn't be
// silently undone by closing the dialog.
let settingsSnapshotOnOpen = null;

function openSettings(){
  document.getElementById('baseUrlInput').value = state.settings.baseUrl;
  document.getElementById('thinkLevelInput').value = state.settings.thinkLevel || 'default';
  document.getElementById('maxTokensInput').value = state.settings.maxTokens || '';
  document.getElementById('corsProxyInput').value = state.settings.corsProxyUrl || '';
  showSettingsMessage('');
  state.addingModel = false;
  state.addingPreset = false;
  state.editingPresetId = null;
  const chatAtOpen = getCurrentChat();
  settingsSnapshotOnOpen = {
    models: [...(state.settings.models || [])],
    activeModel: state.settings.activeModel,
    promptPresets: JSON.parse(JSON.stringify(state.settings.promptPresets || [])),
    chatId: chatAtOpen ? chatAtOpen.id : null,
    chatModel: chatAtOpen ? chatAtOpen.model : null
  };
  renderModelListSettings();
  renderPresetListSettings();
  renderStorageSettings();
  document.getElementById('settingsModal').style.display = 'flex';
}
function closeSettings(){
  document.getElementById('settingsModal').style.display = 'none';
}
function cancelSettings(){
  if(settingsSnapshotOnOpen){
    state.settings.models = settingsSnapshotOnOpen.models;
    state.settings.activeModel = settingsSnapshotOnOpen.activeModel;
    state.settings.promptPresets = settingsSnapshotOnOpen.promptPresets;
    persistSettings();
    if(settingsSnapshotOnOpen.chatId){
      const chat = state.chats.find(c => c.id === settingsSnapshotOnOpen.chatId);
      if(chat && chat.model !== settingsSnapshotOnOpen.chatModel){
        chat.model = settingsSnapshotOnOpen.chatModel;
        persistChats();
      }
    }
    renderChatList();
    renderModelSelect();
  }
  settingsSnapshotOnOpen = null;
  closeSettings();
}

// Builds the "Chat storage" panel: local-file status + actions when a save
// file is connected (or needs reconnecting), or Export/Import + the connect
// button when everything's still browser-only.
function renderStorageSettings(){
  const el = document.getElementById('storageSettings');
  if(!el) return;

  if(state.settings.useLocalFile){
    if(saveDirHandle){
      el.innerHTML = `
        <div class="storage-status"><span>Saving to <span class="folder-name">${escapeHtml(saveDirHandle.name)}</span></span></div>
        <div class="storage-buttons">
          <button class="btn btn-secondary" onclick="disconnectLocalSaveFile()">Disconnect</button>
        </div>`;
    } else if(pendingSaveDirHandle){
      el.innerHTML = `
        <div class="storage-status"><span>⚠ Local save file needs to be reconfirmed</span></div>
        <div class="storage-buttons">
          <button class="btn btn-primary" onclick="reconnectLocalSaveFile()">Reconnect</button>
          <button class="btn btn-secondary" onclick="disconnectLocalSaveFile()">Disconnect</button>
        </div>`;
    } else {
      el.innerHTML = `
        <div class="storage-status"><span>Local file mode is on, but this browser can't connect to it.</span></div>
        <div class="storage-buttons">
          <button class="btn btn-secondary" onclick="disconnectLocalSaveFile()">Turn off local file mode</button>
        </div>`;
    }
  } else {
    el.innerHTML = `
      <div class="storage-status"><span>Chats are saved in this browser only.</span></div>
      <div class="storage-buttons">
        <button class="btn btn-primary" onclick="connectLocalSaveFile()">Use a local save file…</button>
        <button class="btn btn-secondary" onclick="exportData()">⬆ Export data</button>
        <button class="btn btn-secondary" onclick="triggerImport()">⬇ Import data</button>
      </div>`;
  }
}
function saveSettings(){
  const baseUrl = document.getElementById('baseUrlInput').value.trim().replace(/\/$/,'');
  if(!baseUrl){
    showSettingsMessage('Please enter a server URL.', true);
    return;
  }
  const maxTokensRaw = document.getElementById('maxTokensInput').value.trim();
  const maxTokens = maxTokensRaw ? parseInt(maxTokensRaw, 10) : null;
  if(maxTokensRaw && (!Number.isFinite(maxTokens) || maxTokens < 1)){
    showSettingsMessage('Max response length must be a positive number, or left blank for no limit.', true);
    return;
  }
  state.settings.baseUrl = baseUrl;
  state.settings.thinkLevel = document.getElementById('thinkLevelInput').value;
  state.settings.maxTokens = maxTokens;
  state.settings.corsProxyUrl = document.getElementById('corsProxyInput').value.trim() || DEFAULT_CORS_PROXY;
  persistSettings();
  settingsSnapshotOnOpen = null;
  closeSettings();
  checkConnection();
}

// Fetches the list of models Ollama actually has installed and adds any
// that aren't already in the registry. Never removes existing entries.
async function detectModels(){
  const btn = document.getElementById('detectModelsBtn');
  const baseUrl = document.getElementById('baseUrlInput').value.trim().replace(/\/$/,'') || state.settings.baseUrl;
  const originalLabel = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spin">⟳</span> Detecting…';
  showSettingsMessage('');
  try{
    const res = await fetch(baseUrl + '/api/tags');
    if(!res.ok) throw new Error('bad response');
    const data = await res.json();
    const installed = (data.models || []).map(m => m.name);
    if(!installed.length){
      showSettingsMessage('Ollama is reachable but reports no installed models.', true);
      return;
    }
    const added = installed.filter(name => !state.settings.models.includes(name));
    state.settings.models.push(...added);
    if(added.length && !state.settings.activeModel){
      state.settings.activeModel = state.settings.models[0];
    }
    persistSettings();
    renderModelListSettings();
    renderModelSelect();
    showSettingsMessage(
      added.length
        ? `Added ${added.length} model${added.length > 1 ? 's' : ''}: ${added.join(', ')}`
        : 'All installed models are already registered.',
      false
    );
  }catch(e){
    showSettingsMessage(`Couldn't reach Ollama at ${baseUrl} to detect models.`, true);
  }finally{
    btn.disabled = false;
    btn.innerHTML = originalLabel;
  }
}

// --- Model registry (settings modal list) ---
function renderModelListSettings(){
  const el = document.getElementById('modelList');
  const chat = getCurrentChat();
  const current = resolveActiveModel(chat);
  const models = state.settings.models || [];
  let html = '';

  if(state.addingModel){
    html += `<div class="add-model-row">
        <input type="text" id="newModelInput" placeholder="e.g. llama3.1:8b" autofocus>
        <button onclick="confirmAddModel()">Add</button>
      </div>`;
  }

  if(!models.length){
    html += '<div class="model-empty">No models registered yet.</div>';
  } else {
    models.forEach(name => {
      const isActive = name === current;
      html += `<div class="model-row${isActive ? ' active' : ''}" onclick="selectModelSettings('${escAttr(name)}')">
          <span class="model-name">${isActive ? '<span class="model-check">✓</span>' : ''}${escapeHtml(name)}</span>
          <button class="model-delete" onclick="deleteModelSettings('${escAttr(name)}', event)">✕</button>
        </div>`;
    });
  }

  el.innerHTML = html;

  if(state.addingModel){
    const input = document.getElementById('newModelInput');
    input.focus();
    input.addEventListener('keydown', e => {
      if(e.key === 'Enter'){ e.preventDefault(); confirmAddModel(); }
      if(e.key === 'Escape'){ e.preventDefault(); state.addingModel = false; renderModelListSettings(); }
    });
  }
}

// Small helper to safely embed a value inside an inline onclick="'...'"
// attribute: backslash/single-quote so it can't break out of the JS string
// literal, and double-quote (as an HTML entity) so it can't break out of the
// attribute's own double-quote delimiter.
function escAttr(str){
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '&quot;');
}

function toggleAddModelRow(){
  state.addingModel = !state.addingModel;
  renderModelListSettings();
}

function confirmAddModel(){
  const input = document.getElementById('newModelInput');
  const name = input.value.trim();
  if(!name) return;
  if(!state.settings.models.includes(name)){
    state.settings.models.push(name);
  }
  state.settings.activeModel = name;
  state.addingModel = false;
  persistSettings();
  const chat = getCurrentChat();
  if(chat){ chat.model = name; persistChats(); renderChatList(); }
  renderModelListSettings();
  renderModelSelect();
  checkConnection();
}

function selectModelSettings(name){
  onModelSelectChange(name);
}

function deleteModelSettings(name, ev){
  ev.stopPropagation();
  state.settings.models = state.settings.models.filter(m => m !== name);
  if(state.settings.activeModel === name){
    state.settings.activeModel = state.settings.models[0] || null;
  }
  persistSettings();
  renderModelListSettings();
  renderModelSelect();
  checkConnection();
}

// --- Instruction presets (settings modal list) ---
function renderPresetListSettings(){
  const el = document.getElementById('presetList');
  const presets = state.settings.promptPresets || [];
  let html = '';

  if(state.addingPreset){
    const editing = state.editingPresetId ? presets.find(p => p.id === state.editingPresetId) : null;
    html += `<div class="preset-form">
        <input type="text" id="presetTitleInput" placeholder="Title, e.g. Concise coder" value="${escAttr(editing ? editing.title : '')}">
        <textarea id="presetContentInput" placeholder="Instructions sent to the model as a system prompt...">${escapeHtml(editing ? editing.content : '')}</textarea>
        <div class="preset-form-actions">
          <button class="cancel-btn" onclick="cancelPresetForm()">Cancel</button>
          <button class="save-btn" onclick="confirmSavePreset()">Save</button>
        </div>
      </div>`;
  }

  if(!presets.length){
    html += '<div class="preset-empty">No instruction presets yet.</div>';
  } else {
    presets.forEach(p => {
      html += `<div class="preset-row" onclick="editPreset('${escAttr(p.id)}')">
          <span class="preset-title">${escapeHtml(p.title)}</span>
          <button class="preset-delete" onclick="deletePreset('${escAttr(p.id)}', event)">✕</button>
        </div>`;
    });
  }

  el.innerHTML = html;

  if(state.addingPreset){
    document.getElementById('presetTitleInput').focus();
  }
}

function togglePresetForm(){
  state.addingPreset = !state.addingPreset;
  state.editingPresetId = null;
  renderPresetListSettings();
}

function editPreset(id){
  state.addingPreset = true;
  state.editingPresetId = id;
  renderPresetListSettings();
}

function cancelPresetForm(){
  state.addingPreset = false;
  state.editingPresetId = null;
  renderPresetListSettings();
}

function confirmSavePreset(){
  const title = document.getElementById('presetTitleInput').value.trim();
  const content = document.getElementById('presetContentInput').value.trim();
  if(!title || !content){
    showSettingsMessage('Both a title and instructions are required.', true);
    return;
  }
  if(!state.settings.promptPresets) state.settings.promptPresets = [];

  if(state.editingPresetId){
    const preset = state.settings.promptPresets.find(p => p.id === state.editingPresetId);
    if(preset){ preset.title = title; preset.content = content; }
  } else {
    state.settings.promptPresets.push({ id: newChatId().replace('c_', 'p_'), title, content });
  }
  state.addingPreset = false;
  state.editingPresetId = null;
  persistSettings();
  renderPresetListSettings();
  renderPromptSelect();
}

function deletePreset(id, ev){
  ev.stopPropagation();
  state.settings.promptPresets = (state.settings.promptPresets || []).filter(p => p.id !== id);
  persistSettings();
  renderPresetListSettings();
  renderPromptSelect();
}

