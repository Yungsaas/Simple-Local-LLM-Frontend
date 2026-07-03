// --- Init ---
load();
if(state.chats.length){
  state.currentId = state.chats[0].id;
}
renderChatList();
renderMessages();
renderModelSelect();
checkConnection();
setInterval(checkConnection, 15000);
setInterval(checkProxyStatus, 15000);

// Try to silently pick back up a previously connected local save file. If
// the file has newer/different content than what's cached in localStorage
// (e.g. edited on another device since this browser last synced), adopt it
// and re-render.
tryRestoreLocalSaveFile();
