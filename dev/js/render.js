function escapeHtml(str){
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// --- Full markdown + math rendering (marked + KaTeX, sanitized with DOMPurify) ---
marked.setOptions({ breaks: true, gfm: true });

function renderMarkdown(text){
  const mathStore = [];

  // Protect $$...$$ block math first (so its $ signs aren't touched by inline pass)
  let protectedText = text.replace(/\$\$([\s\S]+?)\$\$/g, (m, expr) => {
    const idx = mathStore.push({ expr, display: true }) - 1;
    return `%%MATH${idx}%%`;
  });

  // Protect $...$ inline math. Heuristic avoids matching bare currency like
  // "costs $9, and $14", requires no whitespace touching the delimiters and
  // no digit right after the closing $ (which would indicate a second price).
  protectedText = protectedText.replace(
    /(?<!\\)\$(?!\s)([^\$\n]*?)(?<!\s)\$(?!\d)/g,
    (m, expr) => {
      const idx = mathStore.push({ expr, display: false }) - 1;
      return `%%MATH${idx}%%`;
    }
  );

  let html = marked.parse(protectedText);

  // Re-insert math, rendered to HTML by KaTeX
  html = html.replace(/%%MATH(\d+)%%/g, (m, idx) => {
    const { expr, display } = mathStore[idx];
    try{
      return katex.renderToString(expr, { throwOnError: false, displayMode: display });
    }catch(e){
      return escapeHtml(display ? `$$${expr}$$` : `$${expr}$`);
    }
  });

  return DOMPurify.sanitize(html, {
    ADD_TAGS: ['semantics', 'annotation'],
    ADD_ATTR: ['encoding']
  });
}

// Adds a working copy button to every code block and wraps tables so wide
// ones can scroll horizontally instead of overflowing the bubble.
function enhanceRenderedContent(container){
  container.querySelectorAll('pre').forEach(pre => {
    if(pre.querySelector('.copy-btn')) return;
    const btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.textContent = 'Copy';
    btn.onclick = () => copyCode(btn);
    pre.appendChild(btn);
  });
  container.querySelectorAll('table').forEach(table => {
    if(table.parentElement.classList.contains('table-wrap')) return;
    const wrap = document.createElement('div');
    wrap.className = 'table-wrap';
    table.parentElement.insertBefore(wrap, table);
    wrap.appendChild(table);
  });
}

function copyCode(btn){
  const code = btn.parentElement.querySelector('code').textContent;
  navigator.clipboard.writeText(code);
  btn.textContent = 'Copied';
  setTimeout(() => btn.textContent = 'Copy', 1500);
}

function renderAssistantContent(msg){
  let html = '';
  if(msg.toolLog && msg.toolLog.length){
    html += renderToolLog(msg.toolLog);
  }
  if(msg.thinking){
    const isDone = !!msg.content || !!msg.stopped;
    const label = isDone
      ? 'Thinking'
      : 'Thinking<span class="typing-dots"><span></span><span></span><span></span></span>';
    html += `<details class="thinking-block"${isDone ? '' : ' open'}>
        <summary>${label}</summary>
        <div class="thinking-text">${escapeHtml(msg.thinking)}</div>
      </details>`;
  }
  if(msg.content){
    html += renderMarkdown(msg.content);
  } else if(msg.stopped){
    html += `<span style="color:var(--text-secondary);">Stopped.</span>`;
  } else if(msg.queued){
    html += `<span style="color:var(--text-secondary);">Queued, waiting for the other model to finish…</span>`;
  } else if(!msg.thinking && !(msg.toolLog && msg.toolLog.length)){
    html += `<div class="typing-dots"><span></span><span></span><span></span></div>`;
  }
  return html;
}

// Renders the collapsible "used N tools" block showing exactly what was
// looked up, search queries, URLs fetched, and a short preview of what
// came back, so tool use is visible and debuggable, not a black box.
function renderToolLog(toolLog){
  const stillRunning = toolLog.some(t => t.status === 'running');
  const labelFor = (t) => {
    if(t.type === 'wikipedia_lookup') return `Wikipedia: "${escapeHtml(t.args.query || '')}"`;
    if(t.type === 'web_search') return `Searching: "${escapeHtml(t.args.query || '')}"`;
    if(t.type === 'web_fetch') return `Fetching: ${escapeHtml(t.args.url || '')}`;
    return escapeHtml(t.type);
  };
  const summary = stillRunning
    ? `Using tools<span class="typing-dots"><span></span><span></span><span></span></span>`
    : `Used ${toolLog.length} tool${toolLog.length > 1 ? 's' : ''}`;
  const body = toolLog.map(t => {
    const status = t.status === 'running' ? ' …' : (t.status === 'aborted' ? ' (cancelled)' : '');
    let preview = '';
    if(t.result){
      const trimmed = t.result.length > 300 ? t.result.slice(0, 300) + '…' : t.result;
      preview = `<div class="tool-log-preview">${escapeHtml(trimmed)}</div>`;
    }
    return `<div class="tool-log-entry"><strong>${labelFor(t)}${status}</strong>${preview}</div>`;
  }).join('');
  return `<details class="thinking-block"${stillRunning ? ' open' : ''}>
      <summary>${summary}</summary>
      <div class="thinking-text">${body}</div>
    </details>`;
}

// Renders the small "42 tok/s · 1.3s" line shown once a response has
// finished streaming. showModel adds the model name (used outside compare
// mode, where the column header doesn't already say which model it is).
function renderAssistantMeta(msg, showModel){
  if(!msg.stats) return '';
  const parts = [];
  if(showModel && msg.model) parts.push(escapeHtml(msg.model));
  if(msg.stats.tps) parts.push(`${msg.stats.tps.toFixed(1)} tok/s`);
  if(msg.stats.ttftMs != null) parts.push(`${(msg.stats.ttftMs/1000).toFixed(1)}s to first token`);
  if(msg.stats.totalMs != null) parts.push(`${(msg.stats.totalMs/1000).toFixed(1)}s total`);
  return parts.join(' · ');
}

function renderMessages(){
  const inner = document.getElementById('messagesInner');
  const chat = getCurrentChat();
  inner.classList.toggle('wide', !!(chat && chat.compare));
  if(!chat || chat.messages.length === 0){
    inner.innerHTML = `<div class="empty-state" id="emptyState">
        <h2>What's on your mind?</h2>
        <p>Chatting with your local Ollama model. Nothing leaves your machine.</p>
      </div>`;
    return;
  }
  inner.innerHTML = '';
  const msgs = chat.messages;
  let i = 0;
  while(i < msgs.length){
    const msg = msgs[i];
    const next = msgs[i + 1];
    // Two consecutive assistant messages sharing a groupId are a
    // compare-mode turn: render them as side-by-side columns.
    if(msg.role === 'assistant' && msg.groupId && next && next.groupId === msg.groupId){
      inner.appendChild(buildCompareRow(msg, next, i, i + 1));
      i += 2;
      continue;
    }
    inner.appendChild(buildMessageRow(msg, i));
    i += 1;
  }
  enhanceRenderedContent(inner);
  scrollToBottom(true);
}

function buildMessageRow(msg, index){
  const row = document.createElement('div');
  row.className = 'msg-row ' + msg.role;
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.dataset.index = index;
  bubble.innerHTML = msg.role === 'assistant'
    ? renderAssistantContent(msg)
    : renderMarkdown(msg.content);
  row.appendChild(bubble);
  if(msg.role === 'assistant'){
    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    meta.dataset.metaIndex = index;
    meta.textContent = renderAssistantMeta(msg, true);
    row.appendChild(meta);
  }
  return row;
}

function buildCompareRow(msgA, msgB, indexA, indexB){
  const row = document.createElement('div');
  row.className = 'msg-row assistant compare-row';
  [[msgA, indexA], [msgB, indexB]].forEach(([msg, index]) => {
    const col = document.createElement('div');
    col.className = 'compare-col';
    const header = document.createElement('div');
    header.className = 'compare-col-header';
    header.textContent = msg.model || 'Model';
    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';
    bubble.dataset.index = index;
    bubble.innerHTML = renderAssistantContent(msg);
    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    meta.dataset.metaIndex = index;
    meta.textContent = renderAssistantMeta(msg, false);
    col.appendChild(header);
    col.appendChild(bubble);
    col.appendChild(meta);
    row.appendChild(col);
  });
  return row;
}

// Updates a single assistant bubble (by its index in chat.messages) in
// place. Used for streaming updates so we don't re-render the whole
// conversation on every token, works the same whether that message is
// part of a normal turn or one column of a compare-mode turn.
function updateStreamingBubble(index){
  const chat = getCurrentChat();
  if(!chat) return;
  const msg = chat.messages[index];
  if(!msg) return;
  const bubble = document.querySelector(`.msg-bubble[data-index="${index}"]`);
  if(bubble){
    bubble.innerHTML = renderAssistantContent(msg);
    enhanceRenderedContent(bubble);
  }
  const meta = document.querySelector(`[data-meta-index="${index}"]`);
  if(meta){
    meta.textContent = renderAssistantMeta(msg, !msg.groupId);
  }
  scrollToBottom();
}

// Scrolls the messages pane to the bottom. By default this only happens if
// the user is already following along (state.autoScroll), so scrolling up
// to reread something during a long generation doesn't get yanked back down
// on every new token. Pass force=true for cases where jumping to the bottom
// is always the right call (sending a message, switching chats, etc).
function scrollToBottom(force){
  const el = document.getElementById('messages');
  if(!force && !state.autoScroll) return;
  el.scrollTop = el.scrollHeight;
  if(force) state.autoScroll = true;
  updateScrollBottomBtn();
}

function jumpToBottom(){
  state.autoScroll = true;
  scrollToBottom(true);
}

function updateScrollBottomBtn(){
  const btn = document.getElementById('scrollBottomBtn');
  if(!btn) return;
  btn.style.display = state.autoScroll ? 'none' : 'flex';
}

