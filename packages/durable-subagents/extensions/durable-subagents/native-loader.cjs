const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
// Embedded Pi rewrites literal import(). The fixed native importer loads our
// self-contained bundle; no user input or provider credentials enter this boundary.
const nativeImport = new Function('url', 'return import(url)');
module.exports = () => nativeImport(pathToFileURL(resolve(__dirname, '../../dist/pi/extension.bundle.cjs')).href).then(module => typeof module.registerDurableSubagents === 'function' ? module : module.default);
