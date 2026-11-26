const PREFIX='mystery-shopper/v3/ledger';
/** Every listed ledger object must be readable; a failed download cannot become zero spend. */
export async function strictPrivateLedger(bucket){
 const listing=await bucket.list(PREFIX,{limit:1000});
 if(listing.error||!Array.isArray(listing.data)||listing.data.length>=1000)throw Error('ledger-list');
 const state={reservations:[],settlements:[]};
 for(const item of listing.data){
  const kind=item.name.startsWith('reserve-')?'reservations':item.name.startsWith('settle-')?'settlements':null;
  if(!kind)continue;
  const r=await bucket.download(`${PREFIX}/${item.name}`);
  if(r.error||!r.data)throw Error('ledger-read');
  state[kind].push(JSON.parse(await r.data.text()));
 }
 return state;
}
