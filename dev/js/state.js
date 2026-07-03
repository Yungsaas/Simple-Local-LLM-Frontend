const STORAGE_KEY = 'ollama_chat_sessions_v1';
const SETTINGS_KEY = 'ollama_chat_settings_v1';

// Default CORS proxy: a script the user runs on localhost (local_cors_proxy.py)
// so web_search/web_fetch never route through a third party. Defined once here
// and reused everywhere the default is needed.
const DEFAULT_CORS_PROXY = 'http://127.0.0.1:8765/?url=';

let state = {
  chats: [],        // {id, title, model, messages:[{role,content}], createdAt, compare, compareModel}
  currentId: null,
  settings: { baseUrl: 'http://localhost:11434', models: ['gemma4:e4b'], activeModel: 'gemma4:e4b', theme: 'light', thinkLevel: 'default', maxTokens: null, useLocalFile: false, promptPresets: [], corsProxyUrl: DEFAULT_CORS_PROXY },
  streaming: false,
  abortControllers: [],
  addingModel: false,
  addingPreset: false,
  editingPresetId: null,
  autoScroll: true,   // whether new content should pull the view down with it
};

function load(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    state.chats = raw ? JSON.parse(raw) : [];
  }catch(e){ state.chats = []; }
  // Migrate the old combined "web browsing" toggle (which used to gate
  // Wikipedia lookup too) onto the new field name, which now only gates
  // the proxy-dependent web_search/web_fetch tools. Wikipedia lookup no
  // longer has a toggle at all, it's always available.
  state.chats.forEach(chat => {
    if(chat && chat.webBrowsingEnabled !== undefined && chat.webSearchEnabled === undefined){
      chat.webSearchEnabled = chat.webBrowsingEnabled;
    }
    delete chat.webBrowsingEnabled;
    // Chats saved before sequential compare existed always ran simultaneously,
    // so preserve that behavior for them rather than silently switching their
    // existing compare chats to the new sequential default.
    if(chat && chat.compare && !chat.compareMode){
      chat.compareMode = 'simultaneous';
    }
  });
  try{
    const s = localStorage.getItem(SETTINGS_KEY);
    if(s) state.settings = JSON.parse(s);
  }catch(e){}
  // Migrate old single-model settings shape { baseUrl, model } to { baseUrl, models, activeModel }
  if(!Array.isArray(state.settings.models)){
    const legacyModel = state.settings.model || 'gemma4:e4b';
    state.settings.models = [legacyModel];
    state.settings.activeModel = legacyModel;
    delete state.settings.model;
    persistSettings();
  }
  if(!state.settings.activeModel && state.settings.models.length){
    state.settings.activeModel = state.settings.models[0];
  }
  if(!state.settings.theme){
    state.settings.theme = 'light';
  }
  if(!state.settings.thinkLevel){
    state.settings.thinkLevel = 'default';
  }
  if(state.settings.maxTokens === undefined){
    state.settings.maxTokens = null;
  }
  if(state.settings.useLocalFile === undefined){
    state.settings.useLocalFile = false;
  }
  if(!Array.isArray(state.settings.promptPresets)){
    state.settings.promptPresets = [];
  }
  // Move anyone still on one of the old public proxies (or with none set) onto
  // the local-only default, so a now-defunct third-party proxy isn't left
  // silently active for users who never touched the setting.
  const RETIRED_PUBLIC_PROXY_DEFAULTS = [
    'https://api.allorigins.win/raw?url=',
    'https://api.codetabs.com/v1/proxy?quest=',
    'https://corsproxy.io/?url='
  ];
  if(!state.settings.corsProxyUrl || RETIRED_PUBLIC_PROXY_DEFAULTS.includes(state.settings.corsProxyUrl)){
    state.settings.corsProxyUrl = DEFAULT_CORS_PROXY;
  }
  applyTheme();
}

function applyTheme(){
  document.documentElement.setAttribute('data-theme', state.settings.theme === 'dark' ? 'dark' : 'light');
  const btn = document.getElementById('themeToggleBtn');
  if(btn){
    btn.textContent = state.settings.theme === 'dark' ? '☀ Light mode' : '☾ Dark mode';
  }
}

function toggleTheme(){
  state.settings.theme = state.settings.theme === 'dark' ? 'light' : 'dark';
  persistSettings();
  applyTheme();
}

function persistChats(){
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.chats));
  if(saveDirHandle) writeJSONFile('chats.json', state.chats);
}
function persistSettings(){
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
}

// Chat IDs need to be safe to compare across devices/browsers for the local
// save-file and import/export reconciliation logic, a plain timestamp could
// theoretically collide if two chats are created in the same millisecond on
// different machines, so we add a random suffix.
function newChatId(){
  return 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

// A fresh chat in its default state. Used both by the "New chat" button and
// by the first message sent into an empty app.
function makeNewChat(){
  return {
    id: newChatId(),
    title: 'New chat',
    model: state.settings.activeModel,
    messages: [],
    createdAt: Date.now(),
    compare: false,
    compareModel: null,
    compareMode: 'simultaneous',
    promptPresetId: null,
    webSearchEnabled: false
  };
}

