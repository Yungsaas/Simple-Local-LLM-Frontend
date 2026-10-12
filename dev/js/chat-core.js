function getCurrentChat(){
  return state.chats.find(c => c.id === state.currentId) || null;
}

// Returns the model that should be used for a given chat: the chat's own
// remembered model if it has one, otherwise the global last-used model.
function resolveActiveModel(chat){
  return (chat && chat.model) || state.settings.activeModel || null;
}

// Resolves a chat's chosen instruction preset to its current content, or
// null if the chat has none (or the preset it referenced was since deleted).
// Resolved fresh each time rather than snapshotted, so editing a preset's
// wording takes effect for future messages in any chat using it.
function resolveSystemPrompt(chat){
  if(!chat || !chat.promptPresetId) return null;
  const preset = (state.settings.promptPresets || []).find(p => p.id === chat.promptPresetId);
  return preset ? preset.content : null;
}

// Builds a fresh, independent history array for one model. In compare mode a
// turn stores two assistant replies under the same groupId; only the one this
// model produced is kept, so its context never includes the other model's
// parallel answer. A new array per call also stops the two concurrent compare
// requests from cross-contaminating via tool-call round-trips, which append to
// the array they're handed.
function buildHistoryForModel(chat, model){
  const systemPrompt = resolveSystemPrompt(chat);
  const history = systemPrompt ? [{ role: 'system', content: systemPrompt }] : [];
  chat.messages.forEach(m => {
    if(m.role === 'assistant' && m.groupId && m.model !== model) return;
    history.push({ role: m.role, content: m.content });
  });
  return history;
}

// Shows the blank "Home" screen: no chat selected, and nothing has been
// created yet. The user can pick a model, an instruction preset, and
// toggle web search/compare right here before ever sending a message --
// those choices live in state.draft and only become a real chat (with a
// sidebar entry) once the first message is actually sent, see
// sendMessage() in chat-send.js. This is also what "+ New chat" does: a
// chat is only worth a sidebar slot once it has something in it.
function goHome(){
  if(state.streaming) return;
  state.currentId = null;
  resetDraft();
  renderChatList();
  renderMessages();
  renderModelSelect();
}

function newChat(){
  goHome();
}

function selectChat(id){
  if(state.streaming) return;
  state.currentId = id;
  renderChatList();
  renderMessages();
  renderModelSelect();
  checkConnection();
}

function deleteChat(id, ev){
  ev.stopPropagation();
  // The chat actively streaming a response is always state.currentId (newChat
  // and selectChat both refuse to change it while streaming), so this is the
  // one case that needs blocking, deleting it would detach the in-flight
  // response from state.chats and silently discard it once it finishes.
  if(state.streaming && id === state.currentId) return;
  state.chats = state.chats.filter(c => c.id !== id);
  if(state.currentId === id){
    state.currentId = state.chats.length ? state.chats[0].id : null;
  }
  persistChats();
  renderChatList();
  renderMessages();
  renderModelSelect();
}

function renderChatList(){
  const homeBtn = document.getElementById('homeBtn');
  if(homeBtn) homeBtn.classList.toggle('active', state.currentId === null);

  const el = document.getElementById('chatList');
  el.innerHTML = '';
  state.chats.forEach(chat => {
    const item = document.createElement('div');
    item.className = 'chat-item' + (chat.id === state.currentId ? ' active' : '');
    item.onclick = () => selectChat(chat.id);
    item.innerHTML = `<span class="chat-title">${escapeHtml(chat.title)}</span>
      <button class="chat-delete" onclick="deleteChat('${chat.id}', event)">✕</button>`;
    el.appendChild(item);
  });
}
