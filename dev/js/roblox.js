// =====================================================================
// Roblox Studio tools
//
// The model's tool calls go to roblox_bridge.py (localhost), which hands
// them to the Studio plugin (OllamaChatBridge.lua) and returns the result.
// Only offered when the chat's "Roblox Studio" toggle is on.
// =====================================================================

const ROBLOX_WRITE_TOOLS = new Set([
  'roblox_write_script',
  'roblox_create_instance',
  'roblox_set_property',
  'roblox_delete_instance'
]);

const ROBLOX_PATH_NOTE = 'Paths use "/" between names and start at a service, e.g. "Workspace/Map/Door" or "ServerScriptService/GameManager". Names are case-sensitive.';
const ROBLOX_VALUE_NOTE = 'Values are plain strings: "true"/"false", "42", "Hello", "Vector3(4, 1, 2)", "Vector2(1, 2)", "Color3(255, 0, 0)" (0-255), "UDim2(0.5, 0, 0, 40)" (scaleX, offsetX, scaleY, offsetY), "CFrame(x, y, z)" or "CFrame(x, y, z, rotX, rotY, rotZ)" (degrees), or an enum name like "Brick" / "Enum.Material.Brick".';

const ROBLOX_SYSTEM_NOTE =
  'You can inspect and edit the Roblox Studio place the user currently has open, using the roblox_* tools. ' +
  'Look before you change anything: use roblox_get_tree / roblox_get_selection / roblox_read_script to see what exists, ' +
  'and never guess instance names or paths. Make small, targeted edits. When rewriting a script, read it first and write back the complete new source. ' +
  'Each edit may need the user\'s approval; if they decline, do not retry it, ask what they want instead. ' +
  'You only get a limited number of tool rounds per message, so when several calls are independent (e.g. creating several parts), request them together in one step instead of one at a time. ' +
  'Luau is the scripting language. Briefly tell the user what you changed when you finish.';

const ROBLOX_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'roblox_get_tree',
      description: 'List the children of an instance in the open Roblox Studio place, as an indented tree with class names. With no path it starts at "game" (the top-level services). ' + ROBLOX_PATH_NOTE,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Instance to list the children of. Omit for the top level.' },
          depth: { type: 'integer', description: 'How many levels deep to list (1-6, default 2).' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'roblox_get_selection',
      description: 'Return the instances currently selected in Studio. Use this when the user says "this part", "the selected script", etc.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'roblox_get_properties',
      description: 'Read properties of an instance. With no "properties" given, returns a set of common ones (Name, Position, Size, Color, Material, Anchored, ...). ' + ROBLOX_PATH_NOTE,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Instance path.' },
          properties: { type: 'string', description: 'Optional comma-separated property names, e.g. "Size, Position, Material".' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'roblox_read_script',
      description: 'Read the full source of a Script, LocalScript or ModuleScript (includes unsaved edits from the open editor). ' + ROBLOX_PATH_NOTE,
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Script path.' } },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'roblox_write_script',
      description: 'Replace the ENTIRE source of an existing script. Read it first with roblox_read_script and send back the complete new source. To make a new script, use roblox_create_instance instead.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path of the existing script.' },
          source: { type: 'string', description: 'The complete new Luau source.' }
        },
        required: ['path', 'source']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'roblox_create_instance',
      description: 'Create a new instance (Part, Model, Folder, Script, ModuleScript, ScreenGui, ...) under a parent. For scripts, put the code in properties.Source. ' + ROBLOX_VALUE_NOTE,
      parameters: {
        type: 'object',
        properties: {
          parent: { type: 'string', description: 'Path of the parent instance, e.g. "Workspace" or "ServerScriptService".' },
          className: { type: 'string', description: 'Roblox class name, e.g. "Part", "Script".' },
          name: { type: 'string', description: 'Name for the new instance.' },
          properties: { type: 'object', description: 'Optional map of property name to string value, e.g. {"Size": "Vector3(4,1,2)", "Anchored": "true", "Color": "Color3(255,0,0)"}.' }
        },
        required: ['parent', 'className']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'roblox_set_property',
      description: 'Set one property on an existing instance. Setting "Parent" (value = a path) moves it. ' + ROBLOX_VALUE_NOTE,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Instance path.' },
          property: { type: 'string', description: 'Property name, e.g. "Size".' },
          value: { type: 'string', description: 'New value as a string (see tool description).' }
        },
        required: ['path', 'property', 'value']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'roblox_delete_instance',
      description: 'Delete an instance and everything inside it. Top-level services cannot be deleted. The user can undo this with Ctrl+Z in Studio.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Instance path.' } },
        required: ['path']
      }
    }
  }
];

function describeRobloxEdit(name, a){
  a = a || {};
  if(name === 'roblox_write_script'){
    const src = String(a.source || '');
    return `Overwrite script: ${a.path}\n(${src.split('\n').length} lines)\n\n${src.slice(0, 500)}${src.length > 500 ? '\n…' : ''}`;
  }
  if(name === 'roblox_create_instance'){
    const props = a.properties ? '\n' + (typeof a.properties === 'string' ? a.properties : JSON.stringify(a.properties)).slice(0, 400) : '';
    return `Create ${a.className}${a.name ? ' "' + a.name + '"' : ''} under ${a.parent}${props}`;
  }
  if(name === 'roblox_set_property') return `Set ${a.path} → ${a.property} = ${a.value}`;
  if(name === 'roblox_delete_instance') return `DELETE ${a.path} (and everything inside it)`;
  return name;
}

async function robloxBridgeCall(tool, args, signal){
  const base = (state.settings.robloxBridgeUrl || DEFAULT_ROBLOX_BRIDGE).replace(/\/$/, '');
  let res;
  try{
    res = await fetch(base + '/tool', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool, args }),
      signal
    });
  }catch(e){
    if(e.name === 'AbortError') throw e;
    throw new Error(`Couldn't reach the Roblox bridge at ${base} (${e.message}). Start it with \`python3 roblox_bridge.py\`.`);
  }
  const text = await res.text();
  let data;
  try{ data = JSON.parse(text); }catch(e){ data = { ok: res.ok, result: text }; }
  if(!data.ok) throw new Error(String(data.result || `Bridge error ${res.status}`).slice(0, 500));
  return String(data.result);
}

async function runRobloxTool(name, args, signal){
  if(ROBLOX_WRITE_TOOLS.has(name) && state.settings.robloxConfirmWrites !== false){
    const approved = window.confirm(`The model wants to edit your Roblox project:\n\n${describeRobloxEdit(name, args)}\n\nAllow this edit? (You can undo it in Studio with Ctrl+Z.)`);
    if(!approved){
      return 'The user declined this edit. Do not retry it; ask the user what they would like instead.';
    }
  }
  let result = await robloxBridgeCall(name, args, signal);
  if(result.length > 12000){
    result = result.slice(0, 12000) + '\n…[truncated, ' + (result.length - 12000) + ' more characters]';
  }
  return result;
}