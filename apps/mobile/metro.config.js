// Metro in a monorepo. The numerical core lives at packages/core and is
// imported by the phone, the browser, the API and the tests from that one
// place, so Metro has to watch the workspace root and resolve modules from
// both node_modules directories.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);
config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
config.resolver.disableHierarchicalLookup = true;
module.exports = config;
