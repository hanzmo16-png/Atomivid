"""Read-only official-provider checks; never submits or uploads anything."""
import json, math, os, socket, urllib.request, urllib.error

def get(host,path,headers=None):
    req=urllib.request.Request('https://'+host+path,headers=headers or {},method='GET')
    try:
        with urllib.request.urlopen(req,timeout=15) as r:
            raw=r.read(1024*1024)
            try: data=json.loads(raw)
            except Exception: data=None
            return r.status,data
    except urllib.error.HTTPError as e:
        return e.code,None
    except Exception:
        return None,None

def main():
    rows=[]
    for provider,host,var in [('bfl','api.bfl.ai','BFL_API_KEY'),('ltx','api.ltx.io','LTX_API_KEY')]:
        dns=False
        try: socket.getaddrinfo(host,443);dns=True
        except Exception: pass
        status,_=get(host,'/openapi.json') if dns else (None,None)
        row=dict(provider=provider,dns=dns,https=status is not None,httpStatus=status,
                 credentialPresent=bool(os.environ.get(var)),authenticated=False,creditsVerified=False)
        if provider=='bfl' and dns and os.environ.get(var):
            code,data=get(host,'/v1/credits',{'x-key':os.environ[var]})
            row['authHttpStatus']=code
            if code==200 and isinstance(data,dict) and isinstance(data.get('credits'),(int,float)) and math.isfinite(data['credits']):
                row.update(authenticated=True,creditsVerified=True,enoughForBaseQuote=data['credits']>=9)
        if provider=='ltx':
            # No documented credit-balance endpoint was established. Do not guess one or
            # treat 404 from an arbitrary job ID as proof of authentication.
            row['requiredEvidence']='Official console API credit balance; existing owned job for free authenticated GET'
            job=os.environ.get('LTX_PREFLIGHT_JOB_ID','')
            if dns and os.environ.get(var) and job and all(c.isalnum() or c=='-' for c in job):
                code,data=get(host,'/v2/image-to-video/'+job,{'Authorization':'Bearer '+os.environ[var]})
                row['authHttpStatus']=code
                row['authenticated']=code==200 and isinstance(data,dict) and data.get('id')==job
        rows.append(row)
    result=dict(connections=rows,productionReady=False,providerCallsPaid=0,
                quoteUsd=4.77,reason='Read-only preflight; adapters/materials/reviews remain required')
    print(json.dumps(result,indent=2))
    with open('vfx-provider-preflight.json','w') as f:json.dump(result,f,indent=2)
    summary=os.environ.get('GITHUB_STEP_SUMMARY')
    if summary:
        with open(summary,'a') as f:
            f.write('## VFX provider preflight (read-only)\n\n')
            f.write('| Provider | DNS | HTTPS | Key configured | Authentication | Balance verified |\n|---|---|---|---|---|---|\n')
            for r in rows:
                f.write('| '+r['provider']+' | '+' | '.join(str(r[k]) for k in ['dns','https','credentialPresent','authenticated','creditsVerified'])+' |\n')
            f.write('\nNo generation or deployment. Production is blocked until all evidence is complete.\n')

if __name__=='__main__':main()
