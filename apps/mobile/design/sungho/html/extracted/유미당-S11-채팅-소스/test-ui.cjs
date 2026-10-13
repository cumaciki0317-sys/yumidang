const fs=require('fs'),assert=require('assert');
const files=['chat.js','flow.js'],text=files.map(f=>fs.readFileSync(__dirname+'/'+f,'utf8'));
for(const s of text){new Function(s);assert(!/\b(?:fetch|XMLHttpRequest|sessionStorage|localStorage|setInterval)\b|Date\.|location\.|history\./.test(s),'No persistence, navigation, time or network processing');}
for(const key of ['active','first','failure','success','blocked','rejected','ended','withdrawn','resubmit','deleted','completed','hostEmpty'])assert(text[0].includes(key+':'),'chat scene '+key);
for(const key of ['conversation','pending','expired','confirmed','change','changeExpired','conflict','cancelled','started'])assert(text[1].includes(key+':'),'appointment scene '+key);
for(const field of ['datetime-local','등록 장소','textarea','flow-validation'])assert(text[1].includes(field));
assert(!text.join('').includes('data-demo-message'));assert(!text.join('').includes('requestExpiresAt'));
console.log('PASS: syntax, 12 chat + 9 appointment fixed scenes, forms and forbidden processing boundary. Source only.');
