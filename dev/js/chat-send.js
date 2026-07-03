// --- Connection check ---
async function checkConnection(){
  const dot = document.getElementById('connDot');
  const label = document.getElementById('connLabel');
  const model = resolveActiveModel(getCurrentChat());
  dot.className = 'conn-dot';
  label.textContent = 'Checking connection…';
  try{
    const res = await fetch(state.settings.baseUrl + '/api/tags');
    if(!res.ok) throw new Error('bad response');
    const data = await res.json();
    const names = (data.models || []).map(m => m.name);
    dot.className = 'conn-dot ok';
    if(model && names.length && !names.includes(model)){
      label.textContent = `Connected · model "${model}" not found locally`;
    } else if(!model){
      label.textContent = 'Connected · no model selected';
    } else {
      label.textContent = 'Connected to Ollama';
    }
  }catch(e){
    dot.className = 'conn-dot err';
    label.textContent = 'Can\'t reach Ollama, check Settings';
  }
}

// --- Sending messages ---
function handleSendClick(){
  if(state.streaming){
    state.abortControllers.forEach(c => c.abort());
    return;
  }
  sendMessage();
}

async function sendMessage(){
  const input = document.getElementById('input');
  const text = input.value.trim();
  if(!text) return;

  let chat = getCurrentChat();
  if(!chat){
    // Nothing existed yet (Home screen) -- this first message is what
    // actually creates the chat and earns it a sidebar slot. Whatever the
    // user configured on Home (preset, web search, compare) via
    // state.draft gets carried over onto the new chat here.
    chat = makeNewChat();
    chat.promptPresetId = state.draft.promptPresetId;
    chat.webSearchEnabled = state.draft.webSearchEnabled;
    chat.compare = state.draft.compare;
    chat.compareModel = state.draft.compareModel;
    chat.compareMode = state.draft.compareMode;
    state.chats.unshift(chat);
    state.currentId = chat.id;
    renderModelSelect();
  }

  chat.messages.push({ role:'user', content: text });
  if(chat.title === 'New chat'){
    chat.title = text.slice(0, 40) + (text.length > 40 ? '…' : '');
  }
  input.value = '';
  autoResize(input);
  persistChats();
  renderChatList();
  renderMessages();

  setStreaming(true);
  state.abortControllers = [];

  // History is snapshotted *before* pushing the placeholder assistant
  // message(s) below, so it never includes the not-yet-answered turn.
  // Built fresh per model via buildHistoryForModel, see its comment for
  // why that matters in compare mode.
  if(chat.compare && chat.compareModel){
    const modelA = resolveActiveModel(chat);
    const modelB = chat.compareModel;
    const historyA = buildHistoryForModel(chat, modelA);
    const historyB = buildHistoryForModel(chat, modelB);
    const groupId = 'cmp_' + Date.now();
    const idxA = chat.messages.length;
    chat.messages.push({ role:'assistant', content:'', thinking:'', model: modelA, groupId });
    const idxB = chat.messages.length;
    // In sequential mode B hasn't started yet, `queued` swaps its bubble to
    // a "Queued" label instead of the typing-dots animation, which would
    // otherwise misleadingly suggest it's already generating.
    const sequential = chat.compareMode === 'sequential';
    chat.messages.push({ role:'assistant', content:'', thinking:'', model: modelB, groupId, queued: sequential });
    renderMessages();

    const ctrlA = new AbortController();
    const ctrlB = new AbortController();
    state.abortControllers.push(ctrlA, ctrlB);

    if(sequential){
      // Run A fully (including any tool-call round-trips) before starting B.
      // If the user hits stop during A, ctrlB is already aborted too, so the
      // fetch() inside B's streamAssistantResponse call rejects immediately
      // with AbortError instead of actually starting a second generation.
      await streamAssistantResponse(chat, idxA, modelA, historyA, ctrlA);
      await streamAssistantResponse(chat, idxB, modelB, historyB, ctrlB);
    } else {
      await Promise.allSettled([
        streamAssistantResponse(chat, idxA, modelA, historyA, ctrlA),
        streamAssistantResponse(chat, idxB, modelB, historyB, ctrlB)
      ]);
    }
  } else {
    const model = resolveActiveModel(chat);
    const history = buildHistoryForModel(chat, model);
    const idx = chat.messages.length;
    chat.messages.push({ role:'assistant', content:'', thinking:'', model });
    renderMessages();

    const ctrl = new AbortController();
    state.abortControllers.push(ctrl);
    await streamAssistantResponse(chat, idx, model, history, ctrl);
  }

  persistChats();
  renderChatList();
  setStreaming(false);
  state.abortControllers = [];
}

// Translates the "Reasoning effort" setting into the value Ollama's `think`
// field expects: false for "off", undefined for "default" (the field is then
// omitted so the model uses its own native default), or a level string
// ("low"/"medium"/"high"/"max") for models with graded thinking budgets
// (Qwen3, DeepSeek R1, GPT-OSS, etc). Models that don't recognize a level
// string typically fall back to their default thinking behavior.
function resolveThinkValue(){
  const level = state.settings.thinkLevel || 'default';
  if(level === 'off') return false;
  if(level === 'default') return undefined; // omit the field, model uses its own native default
  return level; // 'low' | 'medium' | 'high' | 'max'
}

// =====================================================================
// Wikipedia lookup + web browsing tools
//
// Wikipedia's public API (native CORS, no proxy needed) powers reference
// lookups and is always offered to the model. web_search/web_fetch use a
// DuckDuckGo lookup routed through a proxy the user runs locally
// (local_cors_proxy.py, never a public one), so they're gated behind the
// per-chat "Web search" toggle. Everything else still only talks to the
// user's local Ollama server.
// =====================================================================

const MAX_TOOL_ROUNDS = 5;
const TOOL_MIN_INTERVAL_MS = 1000; // minimum gap between tool calls, human-paced rather than bot-paced
let lastToolCallTime = 0;

// Always available, no proxy required.
const WIKIPEDIA_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'wikipedia_lookup',
      description: 'Look up a topic on Wikipedia for reliable reference/encyclopedic information, established facts, historical events, concepts, definitions. Not for current news or very recent events.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Topic or question to look up' } },
        required: ['query']
      }
    }
  }
];

// Only offered to the model when the chat's "Web search" toggle is on,
// since these need the local CORS proxy running.
const WEB_SEARCH_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the live web for current information, recent news, current events, or anything not well covered by Wikipedia. Returns several relevant pages with their titles, URLs, and snippets.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'The search query' } },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: 'Fetch the full content of a specific web page by URL, e.g. one found via web_search, or a URL the user provided directly.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'The full URL to fetch' } },
        required: ['url']
      }
    }
  }
];

// Enforces a minimum gap between tool calls, this is an assistive lookup
// tool making a handful of on-demand requests at human-typing pace, not a
// bulk scraper, and this keeps it that way regardless of how eagerly a
// model chains tool calls.
async function enforceToolRateLimit(signal){
  const wait = lastToolCallTime + TOOL_MIN_INTERVAL_MS - Date.now();
  if(wait > 0){
    await new Promise(resolve => {
      const t = setTimeout(resolve, wait);
      if(signal){
        signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
      }
    });
  }
  lastToolCallTime = Date.now();
}

// Resolves a natural-language query to the best-matching Wikipedia article
// title. Tries the fast `opensearch` endpoint first (prefix-match only,
// great for "Mars", but misses phrase-y queries like "Artificial intelligence
// definition"), then falls back to full-text `list=search`, which matches
// words anywhere regardless of order.
async function resolveWikipediaTitle(query, signal){
  const openSearchUrl = `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(query)}&limit=1&namespace=0&format=json&origin=*`;
  const openSearchRes = await fetch(openSearchUrl, { signal });
  if(openSearchRes.ok){
    const [, titles] = await openSearchRes.json();
    if(titles && titles.length) return titles[0];
  }
  const fullTextUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=1&format=json&origin=*`;
  const fullTextRes = await fetch(fullTextUrl, { signal });
  if(!fullTextRes.ok) throw new Error('Wikipedia search failed: ' + fullTextRes.status);
  const fullTextData = await fullTextRes.json();
  const hits = fullTextData.query && fullTextData.query.search;
  return hits && hits.length ? hits[0].title : null;
}

async function wikipediaLookup(query, signal){
  const title = await resolveWikipediaTitle(query, signal);
  if(!title) return `No Wikipedia article found for "${query}".`;
  const summaryRes = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`, { signal });
  if(!summaryRes.ok) throw new Error('Wikipedia summary failed: ' + summaryRes.status);
  const summary = await summaryRes.json();
  const pageUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
  return `${summary.title}\n${pageUrl}\n\n${summary.extract || 'No summary available.'}`;
}

// Fetches a URL that the browser itself can't reach directly (CORS) through
// the user's own local proxy. There is deliberately no fallback to a public
// proxy: if the local one isn't running, this fails loudly with instructions
// rather than silently routing the user's data through a service they didn't
// choose.
async function fetchViaCorsProxy(targetUrl, signal){
  const proxy = state.settings.corsProxyUrl || DEFAULT_CORS_PROXY;
  let res;
  try{
    res = await fetch(proxy + encodeURIComponent(targetUrl), { signal });
  }catch(e){
    if(e.name === 'AbortError') throw e;
    // The fetch to the proxy itself never completed, it's not running,
    // wrong port, etc.
    throw new Error(
      `Couldn't reach your local CORS proxy at ${proxy} (${e.message}). ` +
      `Start it with \`python3 local_cors_proxy.py\`, then try again.`
    );
  }
  let text;
  try{
    text = await res.text();
  }catch(e){
    if(e.name === 'AbortError') throw e;
    throw new Error(`Local proxy responded but reading its response failed: ${e.message}`);
  }
  if(!res.ok){
    // The proxy responded, it just couldn't satisfy the request (upstream
    // site rejected it, timed out, TLS error, etc). Surface its actual
    // response body, which carries the real reason, instead of only the
    // status code, that detail is what makes this debuggable.
    throw new Error(`Local proxy couldn't fetch that page (${res.status}): ${text.slice(0, 300)}`);
  }
  return text;
}

// DuckDuckGo wraps result links in its own redirect ("/l/?uddg=...") rather
// than linking straight to the target, this pulls the real URL back out.
function resolveDdgUrl(href){
  try{
    const url = new URL(href, 'https://duckduckgo.com');
    const uddg = url.searchParams.get('uddg');
    return uddg ? decodeURIComponent(uddg) : url.href;
  }catch(e){
    return href;
  }
}

async function duckduckgoSearch(query, signal){
  const targetUrl = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query);
  const html = await fetchViaCorsProxy(targetUrl, signal);
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const results = Array.from(doc.querySelectorAll('.result')).slice(0, 5).map(el => {
    const linkEl = el.querySelector('.result__a');
    if(!linkEl) return null;
    const title = linkEl.textContent.trim();
    const url = resolveDdgUrl(linkEl.getAttribute('href') || '');
    const snippetEl = el.querySelector('.result__snippet');
    const snippet = snippetEl ? snippetEl.textContent.trim() : '';
    return `${title}\n${url}\n${snippet}`;
  }).filter(Boolean);
  return results.length ? results.join('\n\n') : 'No results found.';
}

async function webFetch(url, signal){
  const html = await fetchViaCorsProxy(url, signal);
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,style,noscript').forEach(el => el.remove());
  const text = (doc.body ? doc.body.textContent : html).replace(/\s+/g, ' ').trim();
  return text.slice(0, 6000);
}

// Runs one model-requested tool call and returns its result as plain text
// (or a descriptive error string, so the model can see what went wrong and
// react instead of the whole turn silently failing).
async function executeToolCall(call, signal){
  const name = call.function.name;
  let args = call.function.arguments;
  if(typeof args === 'string'){
    try{ args = JSON.parse(args); }catch(e){ args = {}; }
  }
  await enforceToolRateLimit(signal);
  if(signal && signal.aborted) return 'Cancelled.';
  try{
    if(name === 'wikipedia_lookup') return await wikipediaLookup(args.query || '', signal);
    if(name === 'web_search') return await duckduckgoSearch(args.query || '', signal);
    if(name === 'web_fetch') return await webFetch(args.url || '', signal);
    return `Unknown tool: ${name}`;
  }catch(e){
    if(e.name === 'AbortError') return 'Cancelled.';
    return `Error running ${name}: ${e.message}`;
  }
}

// Streams one model's reply into chat.messages[index], updating the DOM
// incrementally as tokens arrive, and on completion records tokens/sec, time
// to first token, and total latency from Ollama's final "done" payload for
// renderAssistantMeta to display. Independent per call, so two can run
// concurrently for side-by-side comparison. toolRound tracks how many
// tool-call round-trips this turn has made, so a model that keeps chaining
// tool calls can't loop forever.
async function streamAssistantResponse(chat, index, model, history, controller, toolRound){
  toolRound = toolRound || 0;
  if(chat.messages[index].queued){
    delete chat.messages[index].queued;
    updateStreamingBubble(index);
  }
  const startTime = performance.now();
  let firstTokenTime = null;
  let pendingToolCalls = null;
  try{
    const body = {
      model: model,
      messages: history,
      stream: true
    };
    const thinkValue = resolveThinkValue();
    if(thinkValue !== undefined){
      body.think = thinkValue;
    }
    if(state.settings.maxTokens){
      body.options = { num_predict: state.settings.maxTokens };
    }
    if(toolRound < MAX_TOOL_ROUNDS){
      body.tools = chat.webSearchEnabled ? WIKIPEDIA_TOOLS.concat(WEB_SEARCH_TOOLS) : WIKIPEDIA_TOOLS;
    }
    const res = await fetch(state.settings.baseUrl + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify(body)
    });

    if(!res.ok || !res.body){
      throw new Error('Request failed: ' + res.status);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // Handles one parsed NDJSON line from Ollama: applies thinking/content
    // deltas, captures any tool call request, and on the final "done" line,
    // records timing/throughput stats.
    const processLine = (line) => {
      if(!line.trim()) return;
      const json = JSON.parse(line);
      const msg = chat.messages[index];
      let changed = false;
      if(json.message && json.message.thinking){
        msg.thinking += json.message.thinking;
        changed = true;
      }
      if(json.message && json.message.content){
        if(firstTokenTime === null) firstTokenTime = performance.now();
        msg.content += json.message.content;
        changed = true;
      }
      if(json.message && json.message.tool_calls && json.message.tool_calls.length){
        pendingToolCalls = json.message.tool_calls;
      }
      if(json.done){
        const evalCount = json.eval_count || 0;
        const evalDuration = json.eval_duration || 0; // nanoseconds
        const totalDurationNs = json.total_duration || (performance.now() - startTime) * 1e6;
        msg.stats = {
          tps: evalDuration ? evalCount / (evalDuration / 1e9) : null,
          ttftMs: firstTokenTime !== null ? Math.round(firstTokenTime - startTime) : null,
          totalMs: Math.round(totalDurationNs / 1e6)
        };
        changed = true;
      }
      if(changed) updateStreamingBubble(index);
    };

    while(true){
      const { value, done } = await reader.read();
      if(done) break;
      buffer += decoder.decode(value, { stream:true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for(const line of lines) processLine(line);
    }
    // The stream can close without a trailing newline after the last JSON
    // line (the one carrying done:true and the eval/timing stats), if so
    // it's still sitting in `buffer` and would otherwise be silently lost.
    if(buffer.trim()) processLine(buffer);
  }catch(err){
    if(err.name !== 'AbortError'){
      chat.messages[index].content =
        `⚠ Couldn't reach Ollama at ${state.settings.baseUrl}.\n\nMake sure \`ollama serve\` is running and reachable, then check Settings. Error: ${err.message}`;
      updateStreamingBubble(index);
    } else {
      const msg = chat.messages[index];
      // Marks the turn as finished-via-abort so any in-progress "Thinking…"
      // / typing-dots indicators resolve instead of animating forever, since
      // nothing further will ever arrive to update this bubble.
      msg.stopped = true;
      updateStreamingBubble(index);
    }
    return;
  }

  // If the model asked to use a tool, run it, feed the result back in, and
  // let the model continue, reusing the same message bubble so the tool
  // activity log and eventual answer appear as one continuous turn.
  if(pendingToolCalls && pendingToolCalls.length && toolRound < MAX_TOOL_ROUNDS){
    const msg = chat.messages[index];
    msg.toolLog = msg.toolLog || [];

    history.push({ role: 'assistant', content: msg.content || '', tool_calls: pendingToolCalls });

    for(const call of pendingToolCalls){
      if(controller.signal.aborted) break;
      let args = call.function.arguments;
      if(typeof args === 'string'){ try{ args = JSON.parse(args); }catch(e){ args = {}; } }
      const logEntry = { type: call.function.name, args: args || {}, status: 'running' };
      msg.toolLog.push(logEntry);
      updateStreamingBubble(index);

      const result = await executeToolCall(call, controller.signal);
      if(controller.signal.aborted){
        logEntry.status = 'aborted';
        logEntry.result = 'Cancelled.';
        updateStreamingBubble(index);
        break;
      }
      logEntry.status = 'done';
      logEntry.result = result;
      updateStreamingBubble(index);

      history.push({ role: 'tool', content: result, tool_call_id: call.id });
    }

    if(controller.signal.aborted){
      msg.stopped = true;
      updateStreamingBubble(index);
      return;
    }

    return streamAssistantResponse(chat, index, model, history, controller, toolRound + 1);
  }
}

function setStreaming(on){
  state.streaming = on;
  const btn = document.getElementById('sendBtn');
  btn.textContent = on ? '■' : '↑';
  btn.classList.toggle('stop-btn', on);
}

function autoResize(el){
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 200) + 'px';
}

document.getElementById('input').addEventListener('input', function(){
  autoResize(this);
});
document.getElementById('input').addEventListener('keydown', function(e){
  if(e.key === 'Enter' && !e.shiftKey){
    e.preventDefault();
    handleSendClick();
  }
});

// Tracks whether the user is parked at (or near) the bottom of the
// conversation. Scrolling up during a generation drops autoScroll to false
// so new tokens stop pulling the view down; scrolling back down (or the
// "New output" button) turns it back on.
document.getElementById('messages').addEventListener('scroll', function(){
  const distanceFromBottom = this.scrollHeight - this.scrollTop - this.clientHeight;
  state.autoScroll = distanceFromBottom < 60;
  updateScrollBottomBtn();
});
