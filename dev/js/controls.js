// --- Model dropdown (topbar) ---
function renderModelSelect(){
  const select = document.getElementById('modelSelect');
  const chat = getCurrentChat();
  const current = resolveActiveModel(chat);
  const models = state.settings.models || [];

  if(!models.length && !current){
    select.innerHTML = '<option>No models registered</option>';
    select.disabled = true;
  } else {
    select.disabled = false;
    let options = models.map(m =>
      `<option value="${escapeHtml(m)}"${m === current ? ' selected' : ''}>${escapeHtml(m)}</option>`
    ).join('');

    // If the chat's model was since removed from the registry, still show it
    // (marked as unregistered) so switching chats doesn't silently break.
    if(current && !models.includes(current)){
      options += `<option value="${escapeHtml(current)}" selected>${escapeHtml(current)} (unregistered)</option>`;
    }
    select.innerHTML = options;
  }

  renderCompareUI();
  renderPromptSelect();
  renderWebSearchUI();
}

// --- Instruction preset dropdown (topbar) ---
// Mirrors the model select's pattern: each chat remembers its own preset
// choice, defaulting to "None", changeable at any time (not locked at
// chat creation).
function renderPromptSelect(){
  const select = document.getElementById('promptSelect');
  if(!select) return;
  const chat = getCurrentChat();
  const presets = state.settings.promptPresets || [];
  const currentId = chat ? chat.promptPresetId : null;

  let options = `<option value=""${!currentId ? ' selected' : ''}>No instructions</option>`;
  options += presets.map(p =>
    `<option value="${escapeHtml(p.id)}"${p.id === currentId ? ' selected' : ''}>${escapeHtml(p.title)}</option>`
  ).join('');

  // If the chat references a preset that's since been deleted, still show
  // it (marked as removed) so the dropdown doesn't silently reset.
  if(currentId && !presets.find(p => p.id === currentId)){
    options += `<option value="${escapeHtml(currentId)}" selected>(deleted preset)</option>`;
  }
  select.innerHTML = options;
  select.disabled = !chat;
}

function onPromptSelectChange(value){
  const chat = getCurrentChat();
  if(!chat) return;
  chat.promptPresetId = value || null;
  persistChats();
}

// --- Compare mode (feature: side-by-side model comparison) ---
function renderCompareUI(){
  const chat = getCurrentChat();
  const btn = document.getElementById('compareToggleBtn');
  const modeSelect = document.getElementById('compareModeSelect');
  const select2 = document.getElementById('modelSelect2');
  const models = state.settings.models || [];
  const enabled = !!(chat && chat.compare);

  btn.classList.toggle('active', enabled);
  btn.disabled = !chat;
  modeSelect.style.display = enabled ? '' : 'none';
  select2.style.display = enabled ? '' : 'none';

  if(!enabled) return;

  modeSelect.value = chat.compareMode === 'sequential' ? 'sequential' : 'simultaneous';

  const currentB = chat.compareModel;
  let options = models.map(m =>
    `<option value="${escapeHtml(m)}"${m === currentB ? ' selected' : ''}>${escapeHtml(m)}</option>`
  ).join('');
  if(currentB && !models.includes(currentB)){
    options += `<option value="${escapeHtml(currentB)}" selected>${escapeHtml(currentB)} (unregistered)</option>`;
  }
  select2.innerHTML = options || '<option>No models registered</option>';
  select2.disabled = !models.length;
}

function toggleCompareMode(){
  const chat = getCurrentChat();
  if(!chat) return;
  chat.compare = !chat.compare;
  if(chat.compare && !chat.compareModel){
    const primary = resolveActiveModel(chat);
    const candidates = (state.settings.models || []).filter(m => m !== primary);
    chat.compareModel = candidates[0] || primary || null;
  }
  if(chat.compare && !chat.compareMode){
    chat.compareMode = 'simultaneous';
  }
  persistChats();
  renderCompareUI();
}

// 'simultaneous' (default, matches original behavior) fires both models at
// once via Promise.allSettled, fastest, but needs enough RAM/VRAM to hold
// both models loaded at the same time, and either can slow the other down
// by competing for the same CPU/GPU. 'sequential' runs model A to
// completion, then model B, slower overall, but only one model is ever
// loaded/generating at a time, which matters a lot on machines that can't
// comfortably fit two models in memory at once.
function onCompareModeChange(value){
  const chat = getCurrentChat();
  if(!chat) return;
  chat.compareMode = value === 'sequential' ? 'sequential' : 'simultaneous';
  persistChats();
}

// --- Web search toggle (per-chat, like Compare mode) ---
// Wikipedia lookup needs no toggle, it works with no setup and is always
// offered to the model. This toggle only controls web_search/web_fetch,
// since those need the local CORS proxy running.
function renderWebSearchUI(){
  const btn = document.getElementById('webSearchToggleBtn');
  if(!btn) return;
  const chat = getCurrentChat();
  btn.classList.toggle('active', !!(chat && chat.webSearchEnabled));
  btn.disabled = !chat;
  checkProxyStatus();
}

function toggleWebSearch(){
  const chat = getCurrentChat();
  if(!chat) return;
  chat.webSearchEnabled = !chat.webSearchEnabled;
  persistChats();
  renderWebSearchUI();
}

// Reports whether the local CORS proxy is reachable right now, a page can't
// start or stop a native process, so this only checks it, it can't control
// it. Runs when web search is toggled, when switching to a chat that has it
// on, and periodically while active, so a down proxy surfaces before a tool
// call fails mid-turn.
async function checkProxyStatus(){
  const btn = document.getElementById('webSearchToggleBtn');
  if(!btn) return;
  const chat = getCurrentChat();
  const enabled = !!(chat && chat.webSearchEnabled);
  if(!enabled){
    btn.classList.remove('proxy-error');
    btn.title = 'Let the model search the live web and fetch pages (Wikipedia lookup is always available and needs no toggle)';
    return;
  }
  const proxy = state.settings.corsProxyUrl || DEFAULT_CORS_PROXY;
  btn.classList.add('proxy-checking');
  try{
    // Any response at all (even a 400 for a missing '?url=') proves the
    // proxy process is up and listening, only a network-level failure
    // (connection refused, etc.) means it isn't running.
    await fetch(proxy);
    btn.classList.remove('proxy-error');
    btn.title = 'Web search is on. Local CORS proxy is running.';
  }catch(e){
    btn.classList.add('proxy-error');
    btn.title = `Web search is on, but the local CORS proxy isn't reachable at ${proxy}.\nStart it with: python3 local_cors_proxy.py`;
  }finally{
    btn.classList.remove('proxy-checking');
  }
}

function onModelSelect2Change(value){
  const chat = getCurrentChat();
  if(chat){
    chat.compareModel = value;
    persistChats();
  }
}

function onModelSelectChange(value){
  const chat = getCurrentChat();
  if(chat){
    chat.model = value;
    persistChats();
    renderChatList();
  }
  state.settings.activeModel = value;
  persistSettings();
  renderModelListSettings();
  checkConnection();
}

