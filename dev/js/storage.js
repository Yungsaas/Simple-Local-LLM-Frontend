// =====================================================================
// Local save file (File System Access API) + Export/Import
//
// Chats can live in two places: the browser's localStorage (always, as a
// fast cache/fallback) and, optionally, a real chats.json file the user
// picks via the browser's folder picker. Settings intentionally never
// leave localStorage, server URL, registered models, theme etc. are
// per-device config, not portable data.
// =====================================================================

let saveDirHandle = null;      // live FileSystemDirectoryHandle once connected+granted this session
let pendingSaveDirHandle = null; // a remembered handle whose permission needs re-confirming (user gesture required)

const IDB_NAME = 'ollama_chat_fs';
const IDB_STORE = 'handles';

function idbOpen(){
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbSet(key, value){
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function idbGet(key){
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}
async function idbDelete(key){
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function writeJSONFile(name, data){
  if(!saveDirHandle) return;
  try{
    const fileHandle = await saveDirHandle.getFileHandle(name, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(data, null, 2));
    await writable.close();
  }catch(e){
    console.error('Failed writing ' + name, e);
  }
}
// Returns null if the file doesn't exist yet, rather than throwing.
async function readJSONFile(dirHandle, name){
  try{
    const fileHandle = await dirHandle.getFileHandle(name, { create: false });
    const file = await fileHandle.getFile();
    const text = await file.text();
    return text.trim() ? JSON.parse(text) : null;
  }catch(e){
    return null;
  }
}

// Two chats sharing an ID are safe to auto-merge (keep the longer one) only
// when one's messages are an exact prefix of the other's, i.e. one is just
// the other continued further. If they've actually diverged (edited
// differently in two places before ever syncing), we don't guess: both are
// kept, with the losing copy renamed so nothing is silently discarded.
function messagesArePrefix(shorter, longer){
  if(shorter.length > longer.length) return false;
  for(let i = 0; i < shorter.length; i++){
    if(shorter[i].role !== longer[i].role || shorter[i].content !== longer[i].content) return false;
  }
  return true;
}

function chatSize(chat){
  return (chat.messages || []).reduce((sum, m) => sum + (m.content ? m.content.length : 0), 0);
}

// Merges two chat lists by id, returning { merged, summary } where summary
// is a short human-readable description of what happened (for display).
function reconcileChats(listA, listB){
  const byId = new Map();
  let keptFromEach = 0, resolvedSafely = 0, keptBothOnConflict = 0;

  listA.forEach(chat => byId.set(chat.id, chat));

  listB.forEach(incoming => {
    const existing = byId.get(incoming.id);
    if(!existing){
      byId.set(incoming.id, incoming);
      return;
    }
    const existingMsgs = existing.messages || [];
    const incomingMsgs = incoming.messages || [];
    if(messagesArePrefix(existingMsgs, incomingMsgs)){
      byId.set(incoming.id, incoming); // incoming is existing continued further
      resolvedSafely++;
    } else if(messagesArePrefix(incomingMsgs, existingMsgs)){
      // existing already the longer one, keep it, nothing to do
      resolvedSafely++;
    } else if(chatSize(existing) === chatSize(incoming) &&
              existingMsgs.length === incomingMsgs.length &&
              JSON.stringify(existingMsgs) === JSON.stringify(incomingMsgs)){
      // genuinely identical, keep either, no conflict
      resolvedSafely++;
    } else {
      // real divergence, keep both under distinct ids
      const conflictCopy = { ...incoming, id: newChatId(), title: (incoming.title || 'Chat') + ' (conflict copy)' };
      byId.set(conflictCopy.id, conflictCopy);
      keptBothOnConflict++;
    }
  });

  const merged = Array.from(byId.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const parts = [];
  if(resolvedSafely) parts.push(`merged ${resolvedSafely} duplicate${resolvedSafely > 1 ? 's' : ''}`);
  if(keptBothOnConflict) parts.push(`kept both copies of ${keptBothOnConflict} conflicting chat${keptBothOnConflict > 1 ? 's' : ''}`);
  const summary = parts.length ? parts.join(', ') + '.' : 'no overlapping chats found.';
  return { merged, summary };
}

// Connects (or creates) a local save file. Handles all three cases: no file
// yet, file exists but browser has no chats, or both exist (reconcile).
async function connectLocalSaveFile(){
  if(!('showDirectoryPicker' in window)){
    showSettingsMessage("Your browser doesn't support choosing a local folder (Chrome/Edge/Brave only).", true);
    return;
  }
  try{
    const dirHandle = await window.showDirectoryPicker({ id: 'ollama-chat-saves', mode: 'readwrite' });
    const fileChats = await readJSONFile(dirHandle, 'chats.json');

    saveDirHandle = dirHandle;
    let message;

    if(!fileChats){
      // Case 1: no file yet, create it from whatever's in the browser now.
      await writeJSONFile('chats.json', state.chats);
      message = `Created chats.json in "${dirHandle.name}" with your ${state.chats.length} existing chat(s).`;
    } else if(!state.chats.length){
      // Case 2: file exists, browser has nothing, just adopt the file.
      state.chats = fileChats;
      message = `Loaded ${fileChats.length} chat(s) from "${dirHandle.name}".`;
    } else {
      // Case 3: both exist, reconcile, then write the merged result back.
      const { merged, summary } = reconcileChats(state.chats, fileChats);
      state.chats = merged;
      await writeJSONFile('chats.json', state.chats);
      message = `Connected to "${dirHandle.name}", ${summary}`;
    }

    state.settings.useLocalFile = true;
    persistChats();
    persistSettings();
    await idbSet('saveDir', dirHandle);

    if(!state.chats.find(c => c.id === state.currentId)){
      state.currentId = state.chats.length ? state.chats[0].id : null;
    }
    renderChatList();
    renderMessages();
    renderModelSelect();
    renderStorageSettings();
    showSettingsMessage(message, false);
  }catch(err){
    if(err.name !== 'AbortError'){
      showSettingsMessage('Could not access that folder: ' + err.message, true);
    }
  }
}

function disconnectLocalSaveFile(){
  saveDirHandle = null;
  pendingSaveDirHandle = null;
  state.settings.useLocalFile = false;
  persistSettings();
  idbDelete('saveDir');
  renderStorageSettings();
  showSettingsMessage('Disconnected. Chats remain saved in this browser.', false);
}

async function reconnectLocalSaveFile(){
  if(!pendingSaveDirHandle) return;
  try{
    const perm = await pendingSaveDirHandle.requestPermission({ mode: 'readwrite' });
    if(perm !== 'granted'){
      showSettingsMessage('Permission was not granted.', true);
      return;
    }
    saveDirHandle = pendingSaveDirHandle;
    pendingSaveDirHandle = null;
    const fileChats = await readJSONFile(saveDirHandle, 'chats.json');
    if(fileChats) state.chats = fileChats;
    if(!state.chats.find(c => c.id === state.currentId)){
      state.currentId = state.chats.length ? state.chats[0].id : null;
    }
    renderChatList();
    renderMessages();
    renderModelSelect();
    renderStorageSettings();
    showSettingsMessage('Reconnected to your local save file.', false);
  }catch(e){
    showSettingsMessage('Could not reconnect: ' + e.message, true);
  }
}

// On startup, if the user previously opted into local-file mode, try to
// silently pick the connection back up. Re-granting write permission after
// the browser restarts needs a real user gesture, so if it's not already
// 'granted' we surface a one-click "Reconnect" button instead of a file
// picker (the folder itself is already remembered, this is just a
// permission re-confirmation).
async function tryRestoreLocalSaveFile(){
  if(!state.settings.useLocalFile || !('showDirectoryPicker' in window)) return;
  try{
    const dirHandle = await idbGet('saveDir');
    if(!dirHandle) return;
    const perm = await dirHandle.queryPermission({ mode: 'readwrite' });
    if(perm === 'granted'){
      saveDirHandle = dirHandle;
      const fileChats = await readJSONFile(dirHandle, 'chats.json');
      if(fileChats){
        state.chats = fileChats;
        if(!state.chats.find(c => c.id === state.currentId)){
          state.currentId = state.chats.length ? state.chats[0].id : null;
        }
        renderChatList();
        renderMessages();
        renderModelSelect();
      }
    } else {
      pendingSaveDirHandle = dirHandle;
    }
  }catch(e){ /* ignore, falls back to localStorage silently */ }
  renderStorageSettings();
}

function exportData(){
  const payload = { chats: state.chats, exportedAt: Date.now() };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ollama-chat-export-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function triggerImport(){
  document.getElementById('importFileInput').click();
}

async function handleImportFile(ev){
  const file = ev.target.files[0];
  ev.target.value = ''; // reset so re-importing the same file again still fires 'change'
  if(!file) return;
  try{
    const text = await file.text();
    const data = JSON.parse(text);
    const importedChats = Array.isArray(data.chats) ? data.chats : [];
    if(!importedChats.length){
      showSettingsMessage('That file has no chats in it.', true);
      return;
    }
    // Import only ever touches chat history, never settings, so a stale
    // backup can't accidentally overwrite this machine's server URL, models,
    // theme, etc.
    const { merged, summary } = reconcileChats(state.chats, importedChats);
    state.chats = merged;
    persistChats();
    renderChatList();
    renderMessages();
    renderModelSelect();
    showSettingsMessage(`Imported ${importedChats.length} chat(s), ${summary}`, false);
  }catch(e){
    showSettingsMessage('Could not import that file: ' + e.message, true);
  }
}

