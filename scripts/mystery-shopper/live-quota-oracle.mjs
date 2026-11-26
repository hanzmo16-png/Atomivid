// Independent read-only acceptance oracle. No production billing imports or price identifiers.
function instant(raw) {
  if(typeof raw!=='string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(raw))throw Error('quota timestamp invalid');
  const [year,month,day]=raw.slice(0,10).split('-').map(Number);
  const calendar=new Date(Date.UTC(year,month-1,day));
  if(calendar.getUTCFullYear()!==year || calendar.getUTCMonth()!==month-1 || calendar.getUTCDate()!==day)throw Error('quota calendar date invalid');
  const value=Date.parse(raw);if(!Number.isFinite(value))throw Error('quota timestamp invalid');return value;
}
export function normalUsage(rows,now) {
  const clock=instant(now);const d=new Date(clock);const cutoff=Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),1);
  const seen=new Set();let used=0;
  for(const row of rows){
    if(typeof row.id!=='string'||seen.has(row.id))throw Error('quota rows duplicate or unidentified');seen.add(row.id);
    if(!['processing','completed'].includes(row.status)||row.mode===null||row.mode==='avatar')continue;
    if(typeof row.mode!=='string'||!Object.hasOwn(row,'render_started_at'))throw Error('quota mode or timestamp unavailable');
    const started=instant(row.render_started_at===null?row.created_at:row.render_started_at);
    // Existing server quota is a UTC-month LOWER bound, without an upper bound (future timestamps count too).
    if(started>=cutoff)used++;
  }
  return {used,cutoff:new Date(cutoff).toISOString()};
}
export function quotaExpectation({ownerVisible,status,planLabel,used}) {
  if(typeof ownerVisible!=='boolean'||!Number.isSafeInteger(used)||used<0)throw Error('quota oracle unavailable');
  if(ownerVisible)return {kind:'internal',used};
  if(!['active','trialing'].includes(status))return {kind:'inactive',used};
  const label=String(planLabel??'').replace(/\s+/g,' ').trim();
  const names={'Atomicvid':'Starter','Atomicvid Starter':'Starter','Atomicvid Pro':'Pro','Atomicvid Business':'Business'};
  const planName=names[label];if(!planName)throw Error('billing visible plan unrecognized');
  const limit={Starter:15,Pro:30,Business:60}[planName];
  return {kind:'plan',planName,used,limit,remaining:Math.max(0,limit-used)};
}
export function quotaNoteMatches(expected,visible,text='') {
  const note=text.replace(/\s+/g,' ').trim();
  if(expected.kind==='internal')return visible===false;
  if(!visible)return false;
  if(expected.kind==='inactive')return /Necesitas una suscripción activa para generar videos\./.test(note);
  if(!note.includes(`Tu plan ${expected.planName}:`))return false;
  return expected.remaining>0 ? note.includes(`te quedan ${expected.remaining} de ${expected.limit} videos este mes`) : note.includes(`ya usaste los ${expected.limit} videos de este mes`);
}
export async function readQuotaRows(service,owner) {
  const rows=[];let expectedCount;
  for(let offset=0;offset<5000;offset+=500){
    const result=await service.from('video_requests').select('id,mode,status,render_started_at,created_at',{count:'exact'}).eq('user_id',owner).order('id',{ascending:true}).range(offset,offset+499);
    if(result.error||!Array.isArray(result.data)||!Number.isSafeInteger(result.count)||result.count<0||result.count>5000)throw Error('quota pagination unavailable');
    if(expectedCount===undefined)expectedCount=result.count;
    if(result.count!==expectedCount)throw Error('quota row count changed during read');
    rows.push(...result.data);
    if(rows.length===expectedCount)return rows;
    if(result.data.length!==500||rows.length>expectedCount)throw Error('quota pagination truncated');
  }
  throw Error('quota pagination bound exceeded');
}
