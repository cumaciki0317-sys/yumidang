import {classifyTourApiResponse} from '../../../../../backend/supabase/functions/_shared/integrations/events/tourapi.ts';
import assert from 'node:assert/strict';
for (const body of [{totalCount:null},{totalCount:5,items:{}}]) {
  let rejected=false;let result;
  try {result=classifyTourApiResponse(JSON.stringify({response:{header:{resultCode:'0000'},body}}),5,1);} catch {rejected=true;}
  console.log(JSON.stringify({body,rejected,result}));
  if(!rejected)process.exitCode=1;
}
