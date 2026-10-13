const assert=require('node:assert/strict'),{maskName,RECORDS}=require('./browse.js'),{environment}=require('./test-ui.js');let n=0;const eq=(a,b)=>{assert.equal(a,b);n++},ok=x=>{assert.ok(x);n++};
for(const [input,output] of [['김','*'],['김미','김*'],['김유미','김*미'],['변종현미','변**미'],['이하나','이*나'],['박서연','박*연'],['','*'],['𠮷미','𠮷*'],['𠮷유미','𠮷*미'],['e\u0301가나','e\u0301*나'],['👩‍👩‍👧가나','👩‍👩‍👧*나']])eq(maskName(input),output);
const logged=environment().node('#cards').innerHTML,guest=environment(true).node('#cards').innerHTML;
for(const r of RECORDS){ok(r.fullName.length>0);ok(logged.includes(maskName(r.fullName)));ok(!logged.includes(r.fullName));ok(!guest.includes(maskName(r.fullName)));ok(!guest.includes(r.fullName));}
ok(!logged.includes('김**'));ok(!logged.includes('이**'));ok(!logged.includes('박**'));ok(guest.includes('동행인은 로그인 후 확인할 수 있어요'));
console.log(n+' name-mask and guest-display checks passed (synthetic fixtures, source/mock DOM only).');
