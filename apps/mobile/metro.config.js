const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');
const config = getDefaultConfig(__dirname);
// The address selection normalizer is shared with the server; include its real source in every export.
config.watchFolders = [...config.watchFolders, path.resolve(__dirname, '../../backend/supabase/functions/_shared')];
module.exports = config;
