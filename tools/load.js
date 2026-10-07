const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function load(options = {}) {
  const root = path.join(__dirname, '..');
  const context = { console, fetch, setTimeout, clearTimeout, AbortController, ...options };
  context.window = context; vm.createContext(context);
  const files = ['config', 'util', 'solver', 'tricks', 'narrator', 'culture', 'story', 'generator', 'evidence', 'semantics', 'inference', 'scenarios', 'investigation', 'llm', 'narration'];
  if (options.localConfig) {
    const p = path.join(root, 'js/config.local.js');
    if (fs.existsSync(p)) vm.runInContext(fs.readFileSync(p, 'utf8'), context);
  }
  for (const f of files) vm.runInContext(fs.readFileSync(path.join(root, `js/${f}.js`), 'utf8'), context, { filename: `${f}.js` });
  return context.ASARIYA;
}
module.exports = { load };
