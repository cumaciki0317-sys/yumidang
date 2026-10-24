// Preserve query-string 7's callable CommonJS contract without copying the decoder.
// query-string handles plus signs before decoding; never re-decode the output.
module.exports = require('safe-decode-uri-component').default;
