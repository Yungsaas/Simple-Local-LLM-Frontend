// =====================================================================
// MCP tools (e.g. Roblox Studio's built-in MCP server)
//
// mcp_bridge.py (localhost) launches the MCP servers from mcp_servers.json.
// This file asks it which tools exist, offers them to the model in Ollama's
// tool format, and sends the model's calls back through it. Nothing about a
// specific server is hardcoded: tool names, descriptions and parameters all
// come from the servers themselves. Only offered when the chat's "MCP tools"
// toggle is on.
// =====================================================================

const MCP_CACHE_MS = 30000;
const MCP_MAX_RESULT_CHARS = 12000;

const MCP_SYSTEM_NOTE =
  'You have tools provided by connected MCP servers (their names look like Server__tool_name). ' +
  'Use them when the user\'s request involves what they control. Look before you change anything: ' +
  'use the read/inspect tools first and never guess names, paths or IDs. Make small, targeted changes. ' +
  'Calls that may change something can need the user\'s approval; if the user declines one, do not retry it, ask what they want instead. ' +
  'You only get a limited number of tool rounds per message, so when several calls are independent, request them together in one step instead of one at a time. ' +
  'Briefly tell the user what you did when you finish.';

// Filled by refreshMcpTools(). `tools` is what gets sent to Ollama; `index`
// maps the name the model sees to { server, tool, readOnly }.
const mcpState = {
  tools: [],
  index: new Map(),
  bare: new Map(),     // bare tool name -> entries (fallback if the model drops the "Server__" prefix)
  servers: [],         // [{name, state, error, toolCount}] as last reported by the bridge
  fetchedAt: 0
};

function mcpBase(){
  return (state.settings.mcpBridgeUrl || DEFAULT_MCP_BRIDGE).replace(/\/$/, '');
}

function mcpHeaders(extra){
  return Object.assign({ 'X-Bridge-Token': state.settings.mcpBridgeToken || '' }, extra || {});
}

// Errors thrown here carry a `kind` the UI uses to say what's wrong:
// 'bridge-down' (nothing answering), 'bad-token', or 'other'.
function mcpError(kind, message){
  const e = new Error(message);
  e.kind = kind;
  return e;
}

async function mcpFetch(path, options){
  let res;
  try{
    res = await fetch(mcpBase() + path, options);
  }catch(e){
    if(e.name === 'AbortError') throw e;
    throw mcpError('bridge-down', `Couldn't reach the MCP bridge at ${mcpBase()} (${e.message}). Start it with \`python3 mcp_bridge.py\`.`);
  }
  let data = null;
  try{ data = await res.json(); }catch(e){}
  if(res.status === 401){
    throw mcpError('bad-token', (data && data.error) || 'The MCP bridge rejected the token. Check Settings.');
  }
  if(!res.ok || !data || data.ok === false){
    throw mcpError('other', (data && data.error) || `MCP bridge error ${res.status}`);
  }
  return data;
}

// Turns "Server" + "tool" into a name safe to hand to a model.
function mcpExposedName(server, tool, taken){
  let base = `${server}__${tool}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
  let name = base, n = 2;
  while(taken.has(name)){
    const suffix = '_' + n++;
    name = base.slice(0, 64 - suffix.length) + suffix;
  }
  return name;
}

// Asks the bridge for the current tool list (starting the MCP servers if
// needed) and rebuilds mcpState. Throws the errors from mcpFetch.
async function refreshMcpTools(force){
  if(!force && mcpState.tools.length && Date.now() - mcpState.fetchedAt < MCP_CACHE_MS) return mcpState;
  const data = await mcpFetch('/tools', { headers: mcpHeaders() });
  const tools = [], index = new Map(), bare = new Map();
  (data.tools || []).forEach(t => {
    if(!t || !t.name) return;
    const name = mcpExposedName(t.server, t.name, index);
    const schema = Object.assign({ type: 'object', properties: {} }, t.inputSchema || {});
    if(schema.type !== 'object') schema.type = 'object';
    if(!schema.properties) schema.properties = {};
    const desc = ((t.description || t.title || t.name) + '').trim();
    tools.push({
      type: 'function',
      function: { name, description: `${desc} [via ${t.server}]`, parameters: schema }
    });
    const entry = { server: t.server, tool: t.name, readOnly: !!(t.annotations && t.annotations.readOnlyHint === true) };
    index.set(name, entry);
    if(!bare.has(t.name)) bare.set(t.name, []);
    bare.get(t.name).push(entry);
  });
  mcpState.tools = tools;
  mcpState.index = index;
  mcpState.bare = bare;
  mcpState.servers = data.servers || [];
  mcpState.fetchedAt = Date.now();
  return mcpState;
}

// Finds the tool a model-supplied name refers to: exact match, or (if the
// model dropped the "Server__" prefix) a bare name that is unambiguous.
function resolveMcpTool(name){
  if(mcpState.index.has(name)) return mcpState.index.get(name);
  const matches = mcpState.bare.get(name);
  return matches && matches.length === 1 ? matches[0] : null;
}

function isMcpTool(name){
  return !!resolveMcpTool(name);
}

function describeMcpCall(entry, args){
  let shown;
  try{ shown = JSON.stringify(args || {}, null, 2); }catch(e){ shown = String(args); }
  if(shown.length > 800) shown = shown.slice(0, 800) + '\n…';
  return `Server: ${entry.server}\nTool: ${entry.tool}\n\nArguments:\n${shown}`;
}

// Runs one model-requested MCP tool call and returns plain text. Tools the
// server marks read-only run straight away; anything else asks first (unless
// the user turned that off in Settings), since the model's calls can change
// real projects.
async function runMcpTool(name, args, signal){
  let entry = resolveMcpTool(name);
  if(!entry){
    await refreshMcpTools(true);
    entry = resolveMcpTool(name);
  }
  if(!entry) return `Unknown tool: ${name}. It isn't offered by any connected MCP server.`;

  if(!entry.readOnly && state.settings.mcpConfirmCalls !== false){
    const approved = window.confirm(
      `The model wants to run an MCP tool that may change things:\n\n${describeMcpCall(entry, args)}\n\nAllow this call?`
    );
    if(!approved){
      return 'The user declined this call. Do not retry it; ask the user what they would like instead.';
    }
  }

  const data = await mcpFetch('/call', {
    method: 'POST',
    headers: mcpHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ server: entry.server, tool: entry.tool, arguments: args || {} }),
    signal
  });
  let text = String(data.text || '');
  if(text.length > MCP_MAX_RESULT_CHARS){
    text = text.slice(0, MCP_MAX_RESULT_CHARS) + `\n…[truncated, ${text.length - MCP_MAX_RESULT_CHARS} more characters]`;
  }
  return data.isError ? 'The tool reported an error:\n' + text : text;
}