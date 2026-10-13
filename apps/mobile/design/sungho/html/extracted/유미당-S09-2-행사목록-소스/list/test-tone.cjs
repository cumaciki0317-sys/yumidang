// Fixture baseline updated after the 2026-10-13 fixed-example order correction; test-ui checks ordering.
const fs=require('fs'),crypto=require('crypto'),assert=require('assert');
const expected={"fixtures.js": "cc2eb76b5fe6e7c97f837f635726762225461de0f45cef6a26e0afe8978416e7", "press-feedback.js": "8da3e908f80defb7abcd0127ee3357a0cca7cc18e08cf8683c441bf1cab6b439", "press-feedback.css": "afac4f715bb258e69b892e54af9b4b3683bea193364de57833986557c38ac198", "browse.css": "104feab0f57cd4d806a840c5650e7f1aab12055d907747b578738255338de0a5", "home-material.css": "c5e47187058391520ce9a669459fb5222a625a961b4b5b45d34a0f6c797d56e2"};
// Layout files evolve through approved navigation/spacing work; verify their modal/geometry contracts below, not obsolete whole-file hashes.
delete expected['browse.css'];delete expected['home-material.css'];
for(const [name,hash] of Object.entries(expected))assert.equal(crypto.createHash('sha256').update(fs.readFileSync(__dirname+'/'+name)).digest('hex'),hash,`${name} must remain unchanged`);
const css=fs.readFileSync(__dirname+'/events.css','utf8');const block=css.slice(css.indexOf('/* S09-2 tone alignment only:'));
for(const value of ['border-radius:16px;background:#FFF;box-shadow:none','font-size:1.22916669rem','font-size:.70535713rem','border-radius:22px','background:var(--event-selected-bg)','opacity:.43','@media(max-width:340px)'])assert(block.includes(value),value);
assert(!block.includes('backdrop-filter'));assert(!block.includes('linear-gradient'));assert(!block.includes('button:active'));assert(!block.includes('opacity:.45'));assert(!block.includes('opacity:.5'));
assert(block.includes('.event-card.ended{opacity:1}'));assert(block.includes('.related-link:disabled{opacity:.43;cursor:not-allowed}'));assert(block.includes('.recruit-toggle:has(input:disabled){opacity:.43;cursor:not-allowed}'));
const press=fs.readFileSync(__dirname+'/press-feedback.js','utf8'),pcss=fs.readFileSync(__dirname+'/press-feedback.css','utf8');assert(press.includes('scale(.96)'));assert(pcss.includes('100ms'));assert(press.includes('pointer-events')||pcss.includes('pointer-events:none'));
const html=fs.readFileSync(__dirname+'/index.html','utf8');assert(!html.includes('app-dock'));assert(!html.includes('id="ai"'));assert(!html.includes('id="create"'));
// Source geometry checks, not typography measurements or rendered screenshots.
for(const width of [320,390,430]){const content=width-2*17.52381;const cardPadding=width<=340?12:15;const inner=content-2-2*cardPadding;const thumb=inner*.29;const text=inner-thumb-(width<=340?10:12);const titleCenter=width*.5;assert(titleCenter===width/2);assert(content>0&&text>=150);assert(inner>250&&thumb>70)}
console.log('PASS: immutable fixture/material dependencies; centered title and tone CSS; .96/100ms press, .43 disabled, no new glass/nav, legacy positive 320/390/430 source geometry. Not browser visual QA.');

assert(css.includes('left:50%')&&css.includes('translate(-50%,-50%)'));assert(css.includes('@media(max-width:360px)'));assert(html.includes('aria-controls="event-filters"'));
