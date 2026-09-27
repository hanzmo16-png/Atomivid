"""Build the ocean edit from cached word timings and independently reviewed assets.
Run from repository root with the timing/candidate directory as first argument.
No providers are called. Final free prepare and visual review are mandatory.
"""
import copy,json,sys,re,math
from pathlib import Path
R=Path(sys.argv[1]);D=Path('docs/quality/ocean-deep-001')
timing=json.load(open(R/'episode-word-timings.json'));beats={x['id']:x for x in timing['beats']};words={x['id']:x['words'] for x in timing['words']};allwords=[w for b in timing['words'] for w in b['words']]
old=json.load(open(D/'motion-opening-manifest.json'));catalog=json.load(open(R/'noaa-candidates.json'))+json.load(open(R/'noaa-more-candidates.json'));bySlug={x['slug']:x for x in catalog};reviews=json.load(open(R/'selected-archive-review.json'))['sources']
review={"status":"approved","relevance":"indirecta","note":"Selected from reviewed NOAA/USGS contact sheets; present-day illustrative footage, not archival evidence of the narrated historical event. Source credits and biological limitations retained."}
alias={k:v['slug'] for k,v in reviews.items()};alias.update(mapping='video-playlist-technology-mapping',goosefish='video-playlist-ex1907-anglerfish')
# Make opening sources available as bounded excerpts for later distinct passages.
for k,idx in [('seabed',1),('atolla',2),('zoom',4),('sonar',5)]:
 s=old['scenes'][idx]['source'];bySlug[k]={'url':s['url'],'pageUrl':s['pageUrl'],'creditExcerpt':'Credit '+s['credit']};alias[k]=k

def n(a,start): return ('noaa',a,start)
def p(i,start=0):return ('pexels',i,start)
def c(title):return ('commons',title)
def m(key,title,lat,lon,label):return ('map',key,title,lat,lon,label)
def a(key,prompt):return ('ai',key,prompt)
def g(model,title):return ('science',model,title)
NEG='text, subtitles, logos, monsters, fantasy anatomy, humans, blood, extra eyes, extra fins, exaggerated teeth, bubbles from the fish, camera shaking, scene cuts'
angler='female ceratioid deep-sea anglerfish, Melanocetus-like, small naturally proportioned black body, rounded belly, one thin illicium on the head ending in a small blue-white luminous esca, anatomically plausible fins and teeth, black open water'
# Index = first spoken word of each scene. Text appears over moving footage.
plan={
'b2':[(0,p(32790667),'Sunlight fades below ~200 m'),(20,n('dark',6),'More than 90% of ocean volume'),(34,m('pacific','The deep seafloor covers about two thirds of Earth',0,210,'Pacific Ocean'),None),(45,n('wow',24),'Mapped · Seen · Volume'),(63,n('usgsrobots',25),'Mapped with sonar'),(76,n('sampling',27),'Seen with cameras'),(95,n('water',111),'The largest living space on Earth'),(117,n('waltz',3),'Three measurements. Three different questions.')],
'b3':[(0,p(35114285),'Measuring the deep'),(23,c('File:HMS Challenger (1858).jpg'),'HMS Challenger · 1872–1876'),(46,c('File:Track of H.M.S. Challenger Dec.r 1872 to May 1876 - UvA-BC OTM HB-KZL 62 04 07.jpg'),'Fewer than 500 deep soundings'),(60,m('mariana','Challenger sounding, 1875',11.4,143.27,'8,184 m sounding'),None),(86,p(37234247),'Meteor · ~67,000 echo soundings'),(115,g('rift','Marie Tharp and the Atlantic rift'),None),(134,g('rift','The seafloor is spreading apart'),None),(157,n('mapping',27),'Revealing the shape of the ocean floor'),(175,n('usgsrobots',31),'Today, mapping begins with sound'),(183,g('sonar','A fan of sound pulses'),None),(204,g('sonar','Echo travel time becomes depth'),None),(214,p(17960232),'A strip of seafloor, measured line by line'),(234,n('mapping',34),'Ridges · Canyons · Seamounts'),(249,p(37234248),'A different map comes from space'),(264,g('satellite','Measuring the ocean from space'),None),(285,g('satellite','Gravity leaves a signal at the sea surface'),None),(299,g('satellite','Large features — around 8 km across'),None),(316,n('seeps',82),'Fine details need closer measurements'),(333,g('grid','Seabed 2030 — a mapping standard'),None),(353,g('grid','28.7% mapped — April 2026'),None),(374,g('grid','Almost 5 million km² added in one year'),None),(389,g('grid','“Mapped” has a precise meaning'),None),(398,g('grid','A cell counts once a depth is measured'),None),(417,g('grid','Deep-ocean cells span hundreds of metres'),None),(427,n('seamounts',30),'A map cannot tell us everything that lives there')],
'b4':[(0,n('zoom',2),None),(19,n('seabed',17),None),(29,n('dark',14),'Dark · Cold · High pressure'),(43,n('water',63),'~1 extra atmosphere every 10 m'),(57,n('zoom',40),'At 4,000 m: ~400 atmospheres'),(81,n('waltz',23),'ROVs: power and video through a tether'),(103,n('zoom',54),'Deep Discoverer · Rated to 6,000 m'),(114,n('sampling',69),'Live observation and sample collection'),(136,n('usgsrobots',43),'Crewed submersibles and autonomous vehicles'),(154,n('usgslab',21),'Measuring how much we have seen'),(175,n('usgslab',7),'~44,000 dives · 1958–2024'),(200,n('seabed',27),'Estimated observed area: ~3,800 km²'),(210,n('zoom',65),'About 0.001% of the deep seafloor'),(222,m('rhode-island','An observed area roughly the size of Rhode Island',41.6,-71.5,'Rhode Island'),None),(234,n('usgslab',43),'An estimate, with incomplete records'),(252,m('pacific','Observations cluster near a few coastlines',36,138.5,'Japan'),None),(273,n('wow',59),'United States · Japan · New Zealand'),(280,n('water',91),'High seas: less than a fifth of the dives'),(297,n('sampling',7),'Mapped from afar. Seen only in small patches.')],
'b5':[(0,a('ocean-b5-sparks-v1','Black deep-ocean water with a few very faint blue bioluminescent pinpoints at different distances. No visible fish, no stars, no lightning. Restrained scientific illustration.'),None),(13,n('narcomedusa',15),'Many deep-sea animals can produce light'),(25,m('monterey','A study in Monterey Bay',36.8,-121.9,'Monterey Bay'),None),(44,n('narcomedusa',8),'240 dives · More than 350,000 animals'),(63,n('twitch',12),'About three quarters could produce light'),(73,n('wow',6),'Blue light travels farthest in seawater'),(86,n('dark',23),'Defense · Hunting · Communication'),(103,a('ocean-b5-counterlight-v1','Small silvery midwater fish seen from below against extremely faint blue downwelling light. A neat row of tiny blue ventral photophores matches the background. Plausible fish anatomy, dark open water; restrained counterillumination scientific illustration.'),'Counterillumination'),(115,a('ocean-b5-dragonfish-v1','An anatomically plausible small Malacosteus-like deep-sea dragonfish in black water, viewed from the side, a tiny red suborbital light organ under the eye, restrained natural body proportions and teeth. A faint blue photophore behind the eye. Scientific reconstruction.'),'Some dragonfishes produce red light'),(130,a('ocean-b5-angler-wide-v1',angler+', side view with the complete body visible, slow swimming posture'),'Deep-sea anglerfish'),(149,a('ocean-b5-angler-head-v1',angler+', three-quarter close view of head and single lure, restrained scientific reconstruction'),'A modified fin becomes a glowing lure'),(164,a('ocean-b5-lure-v1','Scientific macro reconstruction of a ceratioid anglerfish esca: a single small translucent rounded luminous bulb at the tip of a thin illicium, soft blue-white bacterial light, dark water, no gigantic bacteria visible.'),'Light from symbiotic bacteria'),(180,a('ocean-b5-lure-detail-v1','Scientific macro reconstruction of an anglerfish luminous esca and slender supporting illicium in black water, a different close side angle, soft blue-white glow confined to the bulb, delicate realistic translucent tissue.'),'A highly dependent symbiosis'),(201,a('ocean-b5-pair-v1','Scientific reconstruction of a sexually parasitic ceratioid anglerfish pair, Ceratias-like female in side profile with one much smaller male attached by its mouth to the ventral flank. Plausible natural anatomy, not Melanocetus, no gore, no transformation, black water.'),'In some species, males fuse to females'),(219,a('ocean-b5-pair-detail-v1','Scientific reconstruction, closer oblique side view of a sexually parasitic ceratioid anglerfish pair, Ceratias-like female with tiny attached male, continuous intact skin at attachment, no surgery or exposed organs, subtle fins, black deep water.'),'Changes to parts of the immune system'),(235,n('dark',56),'A daily journey through the ocean'),(244,n('usgsrobots',35),'The “false bottom” on sonar'),(262,n('wow',38),'It was a living layer'),(275,n('waltz',15),'Small fish · Shrimp · Other animals'),(286,n('dark',72),'Up at dusk. Down before dawn.'),(300,n('wow',85),'The largest daily migration on Earth'),(317,n('narcomedusa',20),'Fish biomass estimates: 2–16 billion tonnes'),(334,n('snowjelly',4),'Marine snow: food falling from above'),(358,n('grenadier',28),'A slow rain through the deep'),(382,n('snowjelly',28),'Observations come from particular places'),(392,n('twitch',25),'Monterey Bay: a clue, not a global census'),(402,n('twitch',34),'The deep ocean is still only partly observed')],
'b6':[(0,n('coffinfish',18),'What remains to be discovered?'),(22,n('usgslab',53),'Ocean Census · >1,100 new species in a year'),(49,n('wow',48),'The number still unknown is uncertain'),(61,n('seeps',30),'Maps point to places worth visiting'),(83,n('seamounts',202),'Cameras and samples reveal communities'),(101,n('vent',11),'A discovery that changed ocean science'),(114,n('smoker',3),'Galápagos Rift · 1977'),(136,n('vent',26),'Hot springs surrounded by life'),(162,n('vent',44),'Life where few expected it'),(175,n('smoker',16),'Chemosynthesis: energy from chemicals'),(196,m('mariana','Challenger Deep — measurements still improve',11.37,142.59,'Challenger Deep'),None),(221,n('grenadier',4),'2021 estimate: 10,935 m ± ~6 m'),(244,n('usgsrobots',77),'Different surveys give different estimates'),(256,c('File:Bathyscaphe Trieste with USS Lewis (DE-535) over the Marianas Trench, 23 January 1960 (NH 96797).jpg'),'Trieste · 1960 · First crewed descent'),(280,n('sampling',88),'Still refining the number')],
'b7':[(0,p(31632561),'How do we know what is down there?'),(9,g('sonar','A map made with sound'),None),(25,n('seamounts',165),'More than a quarter in real detail'),(36,n('usgslab',66),'Seen through cameras and samples'),(60,n('seeps',265),'Charted in outline. Mostly unseen.'),(80,n('water',102),'A map is a location. An observation is a visit.'),(93,n('zoom',76),'One lit patch at a time'),(113,n('seamounts',238),None),(120,n('coffinfish',43),'Earthward Chronicles')]
}
land=json.load(open('remotion/map-land.json'))['regions']
scenes=copy.deepcopy(old['scenes']);scenes[-1]['endSeconds']=beats['b2']['startSec']
# Bind each opening clip to its actual excerpt, retaining adjacent continuation.
for s in scenes:
 if s['source']['kind']=='noaa-video':
  start=s['direction'].pop('mediaStartSeconds',0);s['source']['clip']={'startSeconds':start,'endSeconds':round(start+s['endSeconds']-s['startSeconds']+.05,3)}
# Opening s1 knowingly retains Veo particles; do not claim the provider added nothing.
scenes[0]['review']['note']='Previously approved Veo clip from a NOAA photo, labelled AI recreation. Retains the visible column of particles accepted with the opening.'
ai_count=0

def noaa_source(aliasname,start,dur):
 x=bySlug[alias[aliasname]]
 url=x.get('url') or next(d['url'] for d in x['downloads'] if 'HD version' in d['text'])
 credit=x.get('creditExcerpt','')
 if not credit:
  credit=x['pageText'].split(' Credit ',1)[1].split(' Download ',1)[0]
 credit=credit.strip().removeprefix('Credit ').strip()
 return {'kind':'noaa-video','url':url,'pageUrl':x['pageUrl'],'credit':credit,'clip':{'startSeconds':start,'endSeconds':round(start+dur+.06,3)},'licenseReview':{'date':'2026-09-27','note':'Specific media page and source credit reviewed; NOAA or USGS government work with no third-party exception stated for this video. Source audio discarded. Selected visual excerpt reviewed in the contact sheet.'}}

def boundary(b,i):
 w=words[b]
 if i==0:return beats[b]['startSec']
 return round((w[i-1][2]+w[i][1])/2,4)

for b,entries in plan.items():
 for j,(wi,res,overlay) in enumerate(entries):
  start=boundary(b,wi);end=boundary(b,entries[j+1][0]) if j+1<len(entries) else beats[b]['startSec']+beats[b]['durationSeconds']
  if b=='b7' and j+1==len(entries):end+=1.2
  dur=end-start;s={'id':f'episode-{b}-{j+1:02}','startSeconds':round(start,4),'endSeconds':round(end,4),'narration':'','direction':{'camera':'still','transition':{'type':'cut'}},'provenance':'archival_documentary','review':copy.deepcopy(review)}
  typ=res[0]
  if typ=='noaa':
   s['source']=noaa_source(res[1],res[2],dur);s['creditText']=s['source']['credit']+' · illustrative footage'
   if b=='b6' and wi in [101,114,136,162,175]:s['creditText']=s['source']['credit']+' · modern footage, not 1977'
  elif typ=='pexels':s['source']={'kind':'pexels-video','id':res[1]};s['direction']['mediaStartSeconds']=res[2];s['provenance']='stock_illustrative';s['creditText']='Pexels · illustrative present-day footage';s['review']['note']='Candidate contact sheet reviewed. Pexels License; illustrative surface/shallow-water scene, not an image of a named historic vessel or a deep-sea dive.'
  elif typ=='commons':s['source']={'kind':'commons','title':res[1]};s['direction']['camera']='push';s['fit']='contain';s['creditText']='Wikimedia Commons · public-domain historical archive';s['review']['note']='Candidate title/date, public-domain license and contact sheet reviewed. Historical illustration/photograph; no AI recreation.'
  elif typ=='map':
   _,key,title,lat,lon,label=res;markers=[{'id':s['id'],'label':label,'latitude':lat,'longitude':lon}]
   if b=='b4':markers += [{'id':'nz','label':'New Zealand','latitude':-41,'longitude':174},{'id':'us','label':'United States','latitude':37,'longitude':237.5}] if key=='pacific' else []
   s['source']={'kind':'graphic','spec':{'kind':'map','title':title,'bounds':land[key]['bounds'],'markers':markers,'isFixture':False,'landKey':key}};s['provenance']='data_graphic';s['creditText']='Natural Earth / U.S. Census Bureau · public domain';s['review']['note']='Previously reviewed coastline geometry and bounds. Location/context map, not a measurement of survey coverage.'
  elif typ=='science':
   s['source']={'kind':'graphic','spec':{'kind':'diagram','title':res[2],'oceanModel':res[1],'nodes':[{'id':'schema','label':res[2],'x':.5,'y':.5}],'edges':[],'isFixture':False}};s['provenance']='data_graphic';s['creditText']='Explanatory schematic · not a survey dataset';s['review']['note']='Original deterministic animated schematic; no fabricated numerical measurements. Physical relationship follows the sourced narration. Visual layout requires real render review.'
  elif typ=='ai':
   ai_count+=1;_,key,prompt=res
   ph=('goosefish',(ai_count-1)*8) if ai_count<=6 else ('coffinfish',(ai_count-7)*8)
   s['source']={'kind':'veo-clip','key':key,'reference':{'kind':'ai-still','prompt':'16:9 photorealistic scientific reconstruction. '+prompt+'. No text.','negativePrompt':NEG},'prompt':'One continuous restrained naturalistic underwater shot, 8 seconds. '+prompt+'. Slow smooth movement, minimal camera drift, anatomically stable throughout. Do not introduce objects or additional animals. No titles or lettering.','negativePrompt':NEG,'placeholder':{'source':noaa_source(ph[0],ph[1],8),'provenance':'archival_documentary','creditText':'Temporary preview only · unrelated NOAA benthic fish','camera':'still'}};s['provenance']='ai_recreation';s['creditText']='Scientific reconstruction · not recorded animal behaviour';s['review']['note']='Approved concept and production budget; generated output still requires visual inspection before delivery.'
   if dur>8:raise ValueError((s['id'],dur,'AI exceeds 8 s'))
  if overlay:s['overlay']={'text':overlay,'startSeconds':min(.3,dur/4),'endSeconds':round(min(dur,max(2.5,min(5,dur))),3)}
  scenes.append(s)
for s in scenes:s['narration']=' '.join(w[0] for w in allwords if s['startSeconds'] <= (w[1]+w[2])/2 < s['endSeconds'])
# Explicit visual adjudications remain valid only for these exact source selections.
scene_by_id={s['id']:s for s in scenes}
for reviewed in json.load(open(R/'perceptual-review.json')):
 current=scene_by_id[reviewed['current']];previous=scene_by_id[reviewed['previous']]
 if [current['source'],previous['source']] != reviewed['sources']:raise ValueError('Stale perceptual review: '+current['id'])
 current['review'].setdefault('perceptualDistinctFrom',[]).append({'sceneId':previous['id'],'note':reviewed['note']})
end=round(scenes[-1]['endSeconds'],4)
sounds=[]
for b in beats:
 start=beats[b]['startSec'];stop=start+beats[b]['durationSeconds']+(1.2 if b=='b7' else 0)
 sounds.append({'id':'bed-'+b,'track':'atomivid-suspense-a-v1' if b in ['b1','b3','b4'] else 'atomivid-documentary-b-v1','role':'music','startSeconds':start,'endSeconds':stop,'gain':.8 if b in ['b1','b4'] else .65,'fadeInSeconds':1,'fadeOutSeconds':1,'loop':True})
# Leave a short musical pause after the tiny observed fraction; narration is unchanged.
quiet_start=boundary('b4',222);quiet_end=min(quiet_start+1.5,beats['b4']['startSec']+beats['b4']['durationSeconds'])
bed=next(x for x in sounds if x['id']=='bed-b4');oldend=bed['endSeconds'];bed['endSeconds']=quiet_start;bed['fadeOutSeconds']=.5
sounds.append({**bed,'id':'bed-b4-resume','startSeconds':quiet_end,'endSeconds':oldend,'fadeInSeconds':1})
sounds.extend([{'id':'ambience-'+b,'track':'atomivid-ocean-ambience-v1','role':'ambience','startSeconds':beats[b]['startSec'],'endSeconds':beats[b]['startSec']+beats[b]['durationSeconds'],'gain':.16,'fadeInSeconds':1,'fadeOutSeconds':1,'loop':True} for b in ['b1','b2','b5','b6','b7']])
for b,i in [('b1',0),('b3',183)]:
 t=25 if b=='b1' else boundary(b,i);sounds.append({'id':'sonar-'+b,'track':'atomivid-ocean-sonar-v1','role':'effect','startSeconds':t,'endSeconds':t+3,'gain':.2})
manifest={**old,'beats':list(beats),'outputLabel':'earthward-chronicles-episode','tailSeconds':1.2,'scenes':scenes,'soundCues':sounds,'missingSound':[]}
(D/'episode-manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
print('SCENES',len(scenes),'DURATION',end,'AI_CLIPS',ai_count)
for s in scenes:
 if len(s.get('creditText',''))>180:print('long credit',s['id'])
print('STATIC_ARCHIVE_SECONDS',sum(s['endSeconds']-s['startSeconds'] for s in scenes if s['source']['kind']=='commons'))
