// A native Node import boundary: dependencies use their own ESM export conditions,
// rather than Pi's extension-loader aliases or require-only conditions.
module.exports = () => import('../../dist/pi/extension.js');
