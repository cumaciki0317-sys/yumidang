const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');
const config = getDefaultConfig(__dirname);
// The address selection normalizer is shared with the server; include its real source in every export.
config.watchFolders = [...config.watchFolders, path.resolve(__dirname, '../../backend/supabase/functions/_shared')];
// query-string 7 requires a callable CommonJS decoder; the fixed upstream release is ESM.
const upstreamResolve = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === 'decode-uri-component') {
    return { type: 'sourceFile', filePath: path.resolve(__dirname, 'src/safe-decode-uri.cjs') };
  }
  return (upstreamResolve ?? context.resolveRequest)(context, moduleName, platform);
};
module.exports = config;
