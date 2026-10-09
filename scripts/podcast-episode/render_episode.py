"""Episode compositor: exact narration blocks, word timing, source video and original diagrams.
Usage: python render_episode.py ASSET_DIRECTORY [--previews | --visuals | --avatars | --assemble]
No network or paid-provider calls. Rebuilds are deterministic.
"""
from pathlib import Path
import json, math, random, subprocess, sys, re, unicodedata, wave
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageOps
from concurrent.futures import ProcessPoolExecutor

ROOT=Path(sys.argv[1]); OUT=ROOT/'render';OUT.mkdir(exist_ok=True)
W,H,FPS=1920,1080,25
NAVY=(8,15,28); BLUE=(86,204,231); GOLD=(235,185,110); WHITE=(236,241,246); MUTED=(157,177,197)
FONT='/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
BOLD='/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
SERIF='/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf'
fonts={}; pics={}
def ft(n,bold=False,serif=False):
 key=(n,bold,serif)
 if key not in fonts:fonts[key]=ImageFont.truetype(SERIF if serif else BOLD if bold else FONT,n)
 return fonts[key]
def txt(d,xy,s,size=34,fill=WHITE,bold=False,anchor=None,serif=False):
 d.text(xy,str(s),font=ft(size,bold,serif),fill=fill,anchor=anchor,stroke_width=0)
def lines(d,xy,s,size=42,width=700,fill=WHITE,gap=1.35,bold=False,serif=False):
 x,y=xy;line=''
 for word in s.split():
  test=(line+' '+word).strip()
  if d.textlength(test,font=ft(size,bold,serif))>width and line:
   txt(d,(x,y),line,size,fill,bold,serif=serif);y+=int(size*gap);line=word
  else:line=test
 if line:txt(d,(x,y),line,size,fill,bold,serif=serif)
 return y+int(size*gap)
def ease(x):return .5-.5*math.cos(math.pi*max(0,min(1,x)))
def norm(s):return ''.join(c for c in unicodedata.normalize('NFD',s.lower()) if unicodedata.category(c)!='Mn' and c.isalnum())
M=json.loads((ROOT/'manifest.json').read_text());BLOCKS=M['blocks'];BM={b['id']:b for b in BLOCKS}
def duration(b):
 return float(subprocess.check_output(['ffprobe','-v','error','-show_entries','format=duration','-of','csv=p=0',str(ROOT/f"audio-{b['id']}.mp3")]))
DUR={b['id']:duration(b) for b in BLOCKS}
def cue(b,word,default=0):
 for w in b['words']:
  if norm(w['text'])==norm(word):return w['startSeconds']
 return default
# A subtle original field; no image is represented as observational data.
y,x=np.mgrid[0:H,0:W];glow=np.exp(-((x-1320)**2/(1100**2)+(y-400)**2/(750**2)))
base=np.zeros((H,W,3),np.uint8)
for k,c in enumerate(NAVY):base[:,:,k]=c+glow*[5,13,22][k]
BASE=Image.fromarray(base);del base,x,y,glow
rng=random.Random(731);STARS=[(rng.randrange(W),rng.randrange(140,H-180),rng.uniform(.4,2),rng.uniform(0,6.28)) for _ in range(120)]

def back(t):
 im=BASE.copy();d=ImageDraw.Draw(im)
 for x,y,r,p in STARS:
  val=int(60+55*(.5+.5*math.sin(t*.23+p)));d.ellipse((x-r,y-r,x+r,y+r),fill=(val,val+12,min(255,val+28)))
 return im

def photo(name,t,dur,contain=False):
 key=(name,contain)
 if key not in pics:
  p=ROOT/name
  if not p.exists():raise FileNotFoundError(p)
  src=Image.open(p).convert('RGB')
  if contain:
   im=Image.new('RGB',(W,H),NAVY);q=ImageOps.contain(src,(1400,950),Image.Resampling.LANCZOS);im.paste(q,((W-q.width)//2,(H-q.height)//2));pics[key]=im
  else:pics[key]=ImageOps.fit(src,(W+190,H+108),method=Image.Resampling.LANCZOS)
 src=pics[key]
 if contain:im=src.copy()
 else:
  q=ease(t/max(1,dur));xx=int(q*180);yy=int((1-q)*96);im=src.crop((xx,yy,xx+W,yy+H))
 # Only a video legibility overlay; image provenance stays visible.
 shade=Image.new('RGBA',(W,H),(0,0,0,0));dd=ImageDraw.Draw(shade)
 for yy in range(0,180,4):dd.rectangle((0,yy,W,yy+4),fill=(0,0,0,int(120*(1-yy/180))))
 for yy in range(760,H,4):dd.rectangle((0,yy,W,yy+4),fill=(0,0,0,int(150*(yy-760)/320)))
 return Image.alpha_composite(im.convert('RGBA'),shade).convert('RGB')

def header(im,title,kind='MODELO CONCEPTUAL',chapter='LAS DIMENSIONES DE LA CONCIENCIA'):
 d=ImageDraw.Draw(im);d.rectangle((62,53,67,101),fill=GOLD);txt(d,(87,48),chapter,19,MUTED,True);txt(d,(86,80),title,30,WHITE,True)
 if kind:txt(d,(W-66,62),kind,18,MUTED,anchor='ra')
 return d

def panel(d,box,title,body='',accent=BLUE):
 d.rounded_rectangle(box,20,fill=(12,28,44),outline=(38,65,84),width=2);x,y,xx,yy=box;d.rectangle((x+30,y+30,x+36,y+72),fill=accent);txt(d,(x+57,y+35),title,30,WHITE,True)
 if body:lines(d,(x+36,y+110),body,32,xx-x-72,MUTED)

def project(v,t,scale=220,center=(960,495)):
 a=.35+t*.11;b=.35+t*.073;cx,sx=math.cos(a),math.sin(a);cy,sy=math.cos(b),math.sin(b)
 xx,yy,zz=v[0],v[1],v[2];xx,zz=xx*cx+zz*sx,-xx*sx+zz*cx;yy,zz=yy*cy-zz*sy,yy*sy+zz*cy
 return center[0]+scale*xx,center[1]+scale*yy,zz

def cube(d,t,dimension=3,center=(960,490),scale=210):
 if dimension==0:d.ellipse((center[0]-14,center[1]-14,center[0]+14,center[1]+14),fill=GOLD);return
 if dimension==1:d.line((center[0]-scale,center[1],center[0]+scale,center[1]),fill=BLUE,width=7);return
 verts=[]
 for i in range(2**dimension):
  p=[1 if (i>>j)&1 else -1 for j in range(dimension)]
  if dimension==2:p=p+[0]
  if dimension==4:
   a=t*.12;p[0],p[3]=p[0]*math.cos(a)-p[3]*math.sin(a),p[0]*math.sin(a)+p[3]*math.cos(a);p=[p[k]/(2.5-p[3]) for k in range(3)]
  verts.append(project(p,t,scale,center))
 for i in range(2**dimension):
  for j in range(i+1,2**dimension):
   if (i^j).bit_count()==1:d.line((*verts[i][:2],*verts[j][:2]),fill=GOLD if dimension==4 and ((i^j)==8) else BLUE,width=4)
 for p in verts:d.ellipse((p[0]-6,p[1]-6,p[0]+6,p[1]+6),fill=WHITE)

def graph(d,t,center=(980,490),radius=290,n=28,spread=False):
 rr=random.Random(45);nodes=[]
 for i in range(n):
  a=rr.random()*math.tau;r=math.sqrt(rr.random())*radius;nodes.append((center[0]+r*math.cos(a),center[1]+r*math.sin(a)))
 for i,p in enumerate(nodes):
  for j,q in enumerate(nodes[:i]):
   if math.dist(p,q)<radius*.55:
    pulse=.5+.5*math.sin(t*1.2-i*.5-j*.2);color=(int(30+55*pulse),int(65+80*pulse),int(80+100*pulse));d.line((*p,*q),fill=color,width=2)
    u=(t*.23+i*.13)%1;v=(p[0]*(1-u)+q[0]*u,p[1]*(1-u)+q[1]*u);d.ellipse((v[0]-3,v[1]-3,v[0]+3,v[1]+3),fill=BLUE)
 for i,(x,y) in enumerate(nodes):
  r=5+3*(.5+.5*math.sin(t*1.8-i*.6));d.ellipse((x-r,y-r,x+r,y+r),fill=GOLD if i%7==0 else BLUE)

def sphere(d,t,dur):
 # A single pass through a 2D plane; the cross-section radius follows sqrt(R^2-z^2).
 z=1.2-2.4*ease(t/max(dur,1));r=math.sqrt(max(0,1-z*z))*190
 for i in range(9):
  x=220+i*70;d.line((x,280,x+170,680),fill=(34,65,82),width=2)
 for i in range(9):
  y=280+i*50;d.line((220,y,950,y),fill=(34,65,82),width=2)
 sy=440-z*110;d.ellipse((490,sy-150,790,sy+150),outline=BLUE,width=5);d.ellipse((460,sy-48,820,sy+48),outline=(54,120,148),width=3)
 d.ellipse((640-r,485-r*.25,640+r,485+r*.25),outline=GOLD,width=5)
 d.line((1050,250,1050,745),fill=(43,64,80),width=2)
 if r>0:d.ellipse((1430-r,490-r,1430+r,490+r),outline=GOLD,width=6)
 txt(d,(490,810),'MUNDO EN 3D',25,BLUE);txt(d,(1250,810),'SECCIÓN EN 2D',25,GOLD)

def spectrum(d,t):
 labels=['RADIO','MICROONDAS','INFRARROJO','VISIBLE','ULTRAVIOLETA','RAYOS X','GAMMA']
 colors=[(44,83,117),(48,105,132),(138,88,76),GOLD,(135,89,154),(66,119,164),(84,143,165)]
 widths=[360,240,245,22,225,225,225];x=180
 for i,(label,width) in enumerate(zip(labels,widths)):
  d.rectangle((x,345,x+width-4,465),fill=colors[i])
  if i!=3:txt(d,(x+width/2,502),label,18,WHITE,anchor='ma')
  pts=[(x+k,270+34*math.sin(k*(.024+i*.015)-t*2)) for k in range(width)];d.line(pts,fill=colors[i],width=3)
  if i==3:
   d.rectangle((x-4,337,x+width,473),outline=WHITE,width=3);d.line((x+width/2,473,x+width/2,558),fill=WHITE,width=2);txt(d,(x+width/2,582),'VISIBLE',22,GOLD,True,anchor='mm')
  x+=width
 txt(d,(960,700),'380 – 700 nm',65,WHITE,True,anchor='mm');txt(d,(960,782),'Una franja muy estrecha · espectro simplificado',29,MUTED,anchor='mm')

def label(d,s,y=785,size=42):txt(d,(960,y),s,size,WHITE,True,anchor='mm')

TITLES={
'v01':'Crónicas y Misterios del Universo','v02':'¿Qué es una dimensión?','v03':'La sombra de algo mayor','v04':'Una esfera en Planilandia','v05':'Espacio y tiempo','v07':'Una dimensión enrollada','v08':'Cuerdas y dimensiones extra','v09':'La prueba experimental','v10':'El cerebro y la experiencia','v11':'El problema difícil','v12':'¿Qué se siente ser un murciélago?','v13':'Dos teorías, una pregunta','v14':'Poner las teorías a prueba','v15':'Una hipótesis cuántica','v16':'La ventana de nuestros sentidos','v17':'Cada especie, un mundo','v18':'La realidad como interfaz','v19':'Sombras y apariencias','v20':'¿Dónde está todo el mundo?','v21':'El silencio del cosmos','v22':'La hipótesis interdimensional','v23':'Una analogía no es una prueba','v24':'Lo que dicen los informes','v25':'No identificado ≠ extraterrestre','v26':'El valor de un contraejemplo','v27':'Curiosidad con rigor','a13':'Lo que sabemos — y lo que no','v28':'Nuestro pálido punto azul'}

# Video sequence selection, each plate is an explicitly labelled illustration.
PHOTO={
'v10':('neuron','Visualización conceptual · IA'), 'v11':('theatre','Metáfora visual · IA'),
'v12':('bat','Ilustración conceptual · IA'), 'v14':('laboratory','Recreación de laboratorio · IA'),
'v15':('microtubule','Visualización conceptual · IA'), 'v17':('flower','Ilustración conceptual · IA'),
'v18':('circuits','Ilustración conceptual · IA'), 'v19':('cave','Alegoría ilustrada · IA'),
'v20':('desert','Paisaje ilustrativo · IA'), 'v21':('radio','Ilustración conceptual · IA'),
'v22':('archive','Recreación ilustrativa · IA'), 'v23':('threshold','Especulación ilustrada · IA'),
'v26':('swans','Ilustración conceptual · IA')}

def frame(b,t,dur):
 bid=b['id'];p=t/max(dur,.1);phase=min(3,int(p*4));kind='GRÁFICO EXPLICATIVO'
 photo_duration=.42 if bid not in ['v12','v19','v26'] else .65
 if bid in PHOTO and p<photo_duration:
  name,kind=PHOTO[bid];im=photo('visual-'+name+'.png',t,dur);d=header(im,TITLES[bid],kind.upper())
  if bid=='v12':
   for n in range(4):
    r=50+((t*65+n*110)%520);d.arc((650-r,400-r,650+r,400+r),-65,65,fill=BLUE,width=2)
  elif bid=='v15':label(d,'Orch OR · hipótesis discutida',790,34)
  elif bid=='v26':label(d,'Un solo contraejemplo puede cambiarlo todo',790,36)
  elif bid=='v14':label(d,'fMRI  ·  MEG  ·  iEEG',790,36)
  return im
 if bid in ['v01','v27']:
  im=photo('archive-westerlund.jpg',t,dur);d=header(im,TITLES[bid],'IMAGEN ASTRONÓMICA · NASA / ESA')
  if bid=='v01':
   d.rectangle((110,270,1270,720),fill=(9,19,32));txt(d,(150,303),'EPISODIO 01',24,GOLD,True)
   lines(d,(150,378),'Las dimensiones de la conciencia',76,1010,WHITE,1.15,True,True);txt(d,(154,645),'Con Hans Moreno',30,MUTED)
  else:
   lines(d,(125,260),'Las afirmaciones extraordinarias requieren evidencias extraordinarias.',68,1040,WHITE,1.25,True,True);txt(d,(134,660),'CARL SAGAN · COSMOS, 1980',26,GOLD)
  txt(d,(70,879),'Westerlund 2 · NASA, ESA y equipo científico · Créditos completos al final',19,MUTED)
  return im
 if bid=='v28':
  im=photo('archive-pale-blue-dot.jpg',t,dur,True);d=header(im,TITLES[bid],'IMAGEN REAL · VOYAGER 1')
  txt(d,(90,680),'14 FEB 1990',26,GOLD,True);lines(d,(90,730),'La Tierra, a unos 6 mil millones de kilómetros',35,490,WHITE)
  txt(d,(80,888),'NASA/JPL-Caltech · Versión reprocesada en 2020',22,MUTED);return im
 im=back(t);d=header(im,TITLES.get(bid,bid),kind)
 if bid=='v02':
  bounds=[cue(b,'línea:',9),cue(b,'cuadrado:',15),cue(b,'cubo.',20),cue(b,'teseracto',31)]
  dim=sum(t>=x for x in bounds);cube(d,t,dim,center=(960,440),scale=205);label(d,['0D · Un punto','1D · Una dirección','2D · Una superficie','3D · Un volumen','4D · Proyección de un teseracto'][dim])
 elif bid=='v03':
  if p<.40:cube(d,t,4,scale=300);label(d,'Una proyección no es el objeto completo',790,36)
  else:
   d.rounded_rectangle((190,225,740,810),8,fill=(204,190,154));txt(d,(465,305),'PLANILANDIA',39,(35,42,49),True,anchor='ma');txt(d,(465,386),'Edwin A. Abbott',27,(35,42,49),anchor='ma');txt(d,(465,445),'1884',36,(35,42,49),anchor='ma')
   d.rectangle((350,530,575,755),outline=(45,57,65),width=5);cube(d,t,2,(1330,440),185);lines(d,(1030,690),'Un mundo sin arriba ni abajo',40,690)
 elif bid=='v04':sphere(d,t,dur)
 elif bid=='v05':
  if p<.62:
   cx,cy=970,500;d.line((cx,190,cx,805),fill=MUTED,width=3);d.line((350,cy,1570,cy),fill=MUTED,width=3)
   d.polygon([(cx,cy),(640,200),(1300,200)],fill=(15,54,75));d.polygon([(cx,cy),(640,800),(1300,800)],fill=(20,37,60));d.line((640,200,cx,cy,1300,800),fill=BLUE,width=3);d.line((1300,200,cx,cy,640,800),fill=BLUE,width=3)
   txt(d,(1000,180),'TIEMPO',25,GOLD);txt(d,(1600,495),'ESPACIO',25,GOLD);txt(d,(970,270),'FUTURO',30,WHITE,anchor='mm');txt(d,(970,733),'PASADO',30,WHITE,anchor='mm')
   d.ellipse((cx-10,cy-10,cx+10,cy+10),fill=GOLD)
  else:
   d.ellipse((400,310,850,760),fill=(18,56,84),outline=BLUE,width=3)
   for i in range(3):
    a=t*.25+i*2.09;x=625+300*math.cos(a);y=535+250*math.sin(a);d.rectangle((x-14,y-14,x+14,y+14),fill=GOLD);d.line((625,535,x,y),fill=(47,92,116),width=2)
   lines(d,(1050,350),'Los relojes del GPS necesitan correcciones relativistas',45,690);txt(d,(1060,640),'No es una metáfora.',31,GOLD)
 elif bid=='v07':
  txt(d,(165,210),'KALUZA · 1919',30,GOLD,True);txt(d,(1180,210),'KLEIN · 1926',30,BLUE,True)
  for i in range(27):
   x=310+i*47;r=90;d.ellipse((x-24,420-r,x+24,420+r),outline=(45,125,151),width=3)
  d.line((310,330,1532,330),fill=BLUE,width=3);d.line((310,510,1532,510),fill=BLUE,width=3)
  x=680+250*math.sin(t*.14);y=420+90*math.cos(t*.7);d.ellipse((x-10,y-10,x+10,y+10),fill=GOLD)
  label(d,'De lejos: una línea. De cerca: otra dirección.',720,39)
 elif bid=='v08':
  for j in range(6):
   points=[(220+x,315+j*72+28*math.sin(x*(.009+j*.003)-t*(1+j*.15))) for x in range(1450)];d.line(points,fill=BLUE if j%2 else GOLD,width=3)
  label(d,'10 dimensiones · teoría de cuerdas' if p<.64 else '11 dimensiones · teoría M',805,40)
  txt(d,(85,883),'Propuestas teóricas; las dimensiones adicionales no están observadas.',22,MUTED)
 elif bid=='v09':
  for rr in [250,258]:d.ellipse((700-rr,490-rr,700+rr,490+rr),outline=(53,88,110),width=3)
  for direction,col in [(1,BLUE),(-1,GOLD)]:
   for j in range(18):
    a=t*direction*.7-j*.04*direction;x=700+254*math.cos(a);y=490+254*math.sin(a);r=3+j/6;d.ellipse((x-r,y-r,x+r,y+r),fill=col)
  for i in range(10):
   a=i*math.tau/10;x=700+270*math.cos(a);y=490+270*math.sin(a);d.rectangle((x-15,y-15,x+15,y+15),fill=(64,105,130))
  lines(d,(1110,270),'Posibilidad matemática',42,650);txt(d,(1120,440),'≠',100,GOLD);lines(d,(1110,595),'Hecho observado',42,650)
  txt(d,(160,852),'Esquema conceptual de un colisionador; no es una imagen del LHC.',24,MUTED)
 elif bid in ['v10','v11','v13','v14','v15','a13']:
  if bid=='v13':
   panel(d,(100,235,920,810),'ESPACIO DE TRABAJO GLOBAL','Información disponible para múltiples procesos',GOLD)
   panel(d,(1000,235,1820,810),'INFORMACIÓN INTEGRADA','El sistema considerado como un todo',BLUE)
   graph(d,t,(1410,595),160,24);d.polygon([(510,435),(340,740),(680,740)],fill=(72,62,42));d.ellipse((465,465,555,545),fill=GOLD);txt(d,(175,860),'Teorías en evaluación; ninguna es una explicación definitiva.',24,MUTED)
  elif bid=='v14':
   panel(d,(170,250,880,800),'PREDICCIÓN','¿Qué debería observarse?',BLUE);panel(d,(1040,250,1750,800),'EXPERIMENTO','¿Qué se observó realmente?',GOLD)
   for j in range(3):
    points=[(1090+x,560+j*60+22*math.sin(x*.05-t*(1+j*.2))) for x in range(580)];d.line(points,fill=BLUE,width=3)
   txt(d,(180,855),'Cogitate Consortium · Nature, 2025 · Esquema, no datos experimentales',23,MUTED)
  elif bid=='a13':
   for k,(a,bb) in enumerate([('PERCEPCIÓN','Una ventana limitada'),('DIMENSIONES EXTRA','Posibilidad, no detección'),('CONCIENCIA','Investigación en marcha'),('VISITANTES','Sin prueba científica confirmada')]):
    x=140+(k%2)*855;y=230+(k//2)*290;panel(d,(x,y,x+805,y+250),a,bb,GOLD if k%2 else BLUE)
  else:
   graph(d,t,(1220,495),300,42)
   a,bb={'v10':('86 mil millones','de neuronas, aproximadamente'), 'v11':('Mecanismo ≠ experiencia','David Chalmers · 1995'), 'v15':('Orch OR','Penrose y Hameroff · hipótesis discutida')}[bid]
   lines(d,(120,315),a,62,700,WHITE,1.22,True);lines(d,(130,575),bb,34,680,MUTED)
 elif bid=='v12':
  for i in range(6):
   r=((t*65+i*105)%670);d.arc((500-r,480-r,500+r,480+r),-70,70,fill=BLUE,width=3)
  d.ellipse((477,457,523,503),fill=GOLD);d.line((1120,245,1120,780),fill=MUTED,width=5);d.polygon([(560,500),(1150,360),(1150,600)],outline=BLUE,width=3)
  lines(d,(1230,340),'Describir un sistema no equivale a vivir su experiencia',46,570);txt(d,(130,828),'Thomas Nagel · 1974',27,GOLD)
 elif bid=='v16':spectrum(d,t)
 elif bid=='v17':
  for i,(a,bb) in enumerate([('ABEJA','Ultravioleta'),('MURCIÉLAGO','Ecolocalización'),('HUMANO','Luz visible')]):
   x=130+i*570;panel(d,(x,250,x+520,750),a,bb,[GOLD,BLUE,(178,148,211)][i]);
   for j in range(4):d.ellipse((x+160-j*24,520-j*24,x+360+j*24,580+j*24),outline=(47+j*18,90+j*16,120+j*16),width=2)
  label(d,'UMWELT · el mundo propio de cada ser vivo',825,35)
 elif bid=='v18':
  panel(d,(160,215,920,805),'LA INTERFAZ','Una representación útil',GOLD);panel(d,(1040,215,1780,805),'LO QUE HAY DETRÁS','Procesamiento y complejidad',BLUE)
  for i in range(3):d.rounded_rectangle((260+i*190,470,395+i*190,580),10,fill=(51,120,161));graph(d,t,(1430,570),180,35)
  txt(d,(170,855),'Donald Hoffman · propuesta controvertida, no hecho demostrado',23,MUTED)
 elif bid=='v19':
  panel(d,(130,225,915,775),'FENÓMENO','El mundo tal como se nos aparece',GOLD);panel(d,(1005,225,1790,775),'NOÚMENO','El mundo considerado en sí mismo',BLUE)
  for i in range(12):d.line((950+i*2,250,950+i*2,750),fill=(33,63,87),width=1)
  label(d,'Immanuel Kant · una distinción filosófica',850,32)
 elif bid in ['v20','v21']:
  rr=random.Random(71)
  for i in range(500):
   a=rr.random()*math.tau;r=30+rr.random()*300;a+=r*.014+t*.018;x=880+r*math.cos(a)*1.7;y=475+r*math.sin(a)*.65;c=(140,170,210) if i%3 else GOLD;d.ellipse((x-2,y-2,x+2,y+2),fill=c)
  d.ellipse((838,445,922,505),fill=GOLD)
  if bid=='v20':txt(d,(960,755),'¿Dónde está todo el mundo?',49,WHITE,True,anchor='mm');txt(d,(960,829),'La pregunta de Fermi · 1950',27,MUTED,anchor='mm')
  else:label(d,['Rareza','Distancias','Tiempo','Herramientas de búsqueda'][phase],780,48)
 elif bid=='v22':
  d.line((260,500,1660,500),fill=BLUE,width=4)
  for x,date,title in [(300,'1952','Proyecto Libro Azul'),(930,'1969','Fin del programa'),(1590,'1969','Pasaporte a Magonia')]:
   d.ellipse((x-10,490,x+10,510),fill=GOLD);txt(d,(x,390),date,48,GOLD,True,anchor='mm');lines(d,(x-190,560),title,32,400)
  txt(d,(160,820),'Jacques Vallée · hipótesis interpretativa, no prueba de visitantes',25,MUTED)
 elif bid=='v23':
  sphere(d,t-dur*.65,dur*.35);d.rectangle((290,759,1630,871),fill=(14,30,43));label(d,'Analogía ≠ prueba',815,52)
 elif bid=='v24':
  entries=[('2021','ODNI','144 reportes · datos limitados'),('2023','NASA','Mejores instrumentos y metodología'),('2024','AARO','Sin prueba de tecnología extraterrestre')]
  for i,(year,org,body) in enumerate(entries):
   x=100+i*600;panel(d,(x,235,x+555,815),org,body,GOLD if p>i/3 else BLUE);txt(d,(x+38,650),year,72,GOLD,True)
 elif bid=='v25':
  if p<.56:
   d.rectangle((230,200,1690,820),fill=(28,33,39));x=480+t*17;y=480+70*math.sin(t*.16);d.ellipse((x-22,y-10,x+22,y+10),fill=(196,201,202));d.rectangle((x-65,y-55,x+65,y+55),outline=WHITE,width=2)
   d.line((940,495,980,495),fill=WHITE,width=2);d.line((960,475,960,515),fill=WHITE,width=2);txt(d,(260,225),'RECREACIÓN · NO ES EVIDENCIA',25,GOLD,True)
  else:
   for i,s in enumerate(['Globos y drones','Aves y satélites','Óptica y perspectiva']):panel(d,(180+i*530,280,665+i*530,760),str(i+1).zfill(2),s)
   x=420+20*math.sin(t*.3);y=550+15*math.cos(t*.4);d.ellipse((x-44,y-65,x+44,y+45),outline=BLUE,width=4);d.line((x,y+45,x+10,y+120),fill=MUTED,width=2)
   a=t*.2;x=950+80*math.cos(a);y=570+45*math.sin(a);d.rectangle((x-20,y-20,x+20,y+20),fill=GOLD);d.rectangle((x-85,y-15,x-28,y+15),outline=BLUE,width=3);d.rectangle((x+28,y-15,x+85,y+15),outline=BLUE,width=3)
   d.polygon([(1390,610),(1580,480),(1580,690)],outline=BLUE,width=3);d.ellipse((1365,580,1425,640),outline=GOLD,width=4)

  txt(d,(220,860),'Un caso sin resolver indica falta de explicación, no una causa extraordinaria.',25,MUTED)
 elif bid=='v26':
  panel(d,(190,260,870,780),'HIPÓTESIS','“Todos los cisnes son blancos”',BLUE);panel(d,(1050,260,1730,780),'CONTRAEJEMPLO','Un cisne negro basta para refutarla',GOLD)
  txt(d,(960,510),'→',90,GOLD,anchor='mm');txt(d,(220,855),'Karl Popper · falsabilidad',26,MUTED)
 return im

def ass_time(t):
 c=round(max(0,t)*100);return f'{c//360000}:{c//6000%60:02}:{c//100%60:02}.{c%100:02}'
def subtitles(b):
 path=OUT/f"{b['id']}.ass"
 head='[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\nWrapStyle: 2\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,DejaVu Sans,42,&H00F6F1EC,&H00F6F1EC,&H00110D08,&H75000000,-1,0,0,0,100,100,0,0,1,2.2,0,2,140,140,70,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n'
 ws=b['words']; groups=[];g=[]
 for w in ws:
  if g and (len(' '.join(x['text'] for x in g))+len(w['text'])>63 or len(g)>=10):groups.append(g);g=[]
  g.append(w)
  if w['text'].endswith(('.', '?','!')) and len(g)>3:groups.append(g);g=[]
 if g:groups.append(g)
 ev=[]
 for g in groups:
  for i,w in enumerate(g):
   start=w['startSeconds'];end=g[i+1]['startSeconds'] if i+1<len(g) else w['endSeconds']+.05
   ss=[]
   for j,q in enumerate(g):
    word=q['text'].replace('{','').replace('}','');ss.append(('{\\c&H6EB9EB&}'+word+'{\\c&HF6F1EC&}') if i==j else word)
   ev.append(f'Dialogue: 0,{ass_time(start)},{ass_time(end)},Default,,0,0,0,,'+ ' '.join(ss))
 path.write_text(head+'\n'.join(ev)+'\n');return path

def render_visual(b):
 bid=b['id'];dest=OUT/f'{bid}.mp4'
 if dest.exists():return str(dest)
 dur=DUR[bid];N=math.ceil((dur+.4)*FPS);ass=subtitles(b)
 cmd=['ffmpeg','-v','error','-y','-f','rawvideo','-pix_fmt','rgb24','-s','1920x1080','-r',str(FPS),'-i','pipe:0','-i',str(ROOT/f'audio-{bid}.mp3'),'-vf',f"ass={ass}",'-af','apad=pad_dur=0.6','-t',str(N/FPS),'-c:v','libx264','-preset','fast','-crf','19','-pix_fmt','yuv420p','-threads','2','-c:a','aac','-b:a','192k','-ar','48000','-movflags','+faststart',str(dest)]
 proc=subprocess.Popen(cmd,stdin=subprocess.PIPE)
 try:
  for i in range(N):proc.stdin.write(frame(b,min(i/FPS,dur),dur).tobytes())
 finally:proc.stdin.close()
 if proc.wait()!=0:dest.unlink(missing_ok=True);raise RuntimeError('render failed '+bid)
 print('RENDERED',bid,flush=True);return str(dest)

def render_avatar(b):
 bid=b['id'];dest=OUT/f'{bid}.mp4'
 if dest.exists():return str(dest)
 if bid=='a12':source=ROOT/'probe.mp4';start=.3
 else:
  found=None
  for p in ROOT.glob('batch-*-record.json'):
   rec=json.loads(p.read_text());seg=next((x for x in rec['timeline'] if x['id']==bid),None)
   if seg:found=(ROOT/(rec['segId']+'.mp4'),seg['start']);break
  if not found:raise RuntimeError('missing avatar '+bid)
  source,start=found
 dur=DUR[bid];length=math.ceil((dur+.4)*FPS)/FPS;ass=subtitles(b)
 filters=f"fps=25,scale=1920:1080,setsar=1,tpad=stop_mode=clone:stop_duration=0.6,ass={ass}"
 cmd=['ffmpeg','-v','error','-y','-ss',str(start),'-i',str(source),'-i',str(ROOT/f'audio-{bid}.mp3'),'-map','0:v:0','-map','1:a:0','-vf',filters,'-af','apad=pad_dur=0.6','-t',str(length),'-c:v','libx264','-preset','fast','-crf','18','-pix_fmt','yuv420p','-threads','2','-c:a','aac','-b:a','192k','-ar','48000','-movflags','+faststart',str(dest)]
 subprocess.run(cmd,check=True);print('AVATAR',bid,flush=True);return str(dest)

def previews():
 images=[]
 for b in BLOCKS:
  if b['kind']=='V' or b['id']=='a13':
   for frac in [.20,.78]:
    im=frame(b,DUR[b['id']]*frac,DUR[b['id']]);im.thumbnail((480,270));d=ImageDraw.Draw(im);d.rectangle((0,242,480,270),fill=(0,0,0));d.text((10,247),b['id']+' / '+str(frac),font=ft(15),fill='white');images.append(im)
 sheet=Image.new('RGB',(480*4,270*math.ceil(len(images)/4)),NAVY)
 for i,im in enumerate(images):sheet.paste(im,((i%4)*480,(i//4)*270))
 sheet.save(OUT/'visual-contact.jpg',quality=90)

def credits(seconds):
 dest=OUT/'credits.mp4';N=round(seconds*FPS)
 cmd=['ffmpeg','-v','error','-y','-f','rawvideo','-pix_fmt','rgb24','-s','1920x1080','-r','25','-i','pipe:0','-f','lavfi','-i','anullsrc=r=48000:cl=stereo','-t',str(seconds),'-c:v','libx264','-preset','fast','-crf','19','-pix_fmt','yuv420p','-threads','2','-c:a','aac','-b:a','192k',str(dest)]
 p=subprocess.Popen(cmd,stdin=subprocess.PIPE)
 for i in range(N):
  t=i/FPS;im=back(t);d=header(im,'Crónicas y Misterios del Universo','EPISODIO 01')
  if t<10:
   lines(d,(160,300),'Sigue mirando hacia arriba. Sigue preguntando.',72,1500,WHITE,1.22,True,True);txt(d,(170,700),'Suscríbete para acompañarnos en el próximo episodio',34,GOLD)
  elif t<seconds-12:
   txt(d,(150,230),'IMÁGENES Y PROCEDENCIA',31,GOLD,True)
   lines(d,(150,310),'Westerlund 2: NASA, ESA, the Hubble Heritage Team (STScI/AURA), A. Nota (ESA/STScI), and the Westerlund 2 Science Team',29,1570)
   txt(d,(150,470),'ESA/Hubble · CC BY 4.0 · esahubble.org/images/heic1509a/',25,MUTED)
   txt(d,(150,555),'Pale Blue Dot Revisited: NASA/JPL-Caltech · Voyager 1',28,WHITE)
   lines(d,(150,652),'Presentador virtual y voz clonada utilizados con autorización de Hans. Ilustraciones conceptuales generadas con IA e identificadas en pantalla. Gráficos y música originales.',26,1570,MUTED)
  else:
   txt(d,(150,220),'LECTURAS Y DOCUMENTOS',31,GOLD,True)
   sources=['Edwin A. Abbott · Planilandia (1884)','Thomas Nagel (1974) · David Chalmers (1995)','Cogitate Consortium · Nature (2025) · doi:10.1038/s41586-025-08888-1','ODNI · Evaluación preliminar de UAP (2021)','NASA · UAP Independent Study Team Report (2023)','AARO · Historical Record Report, Vol. 1 (2024)']
   for k,s in enumerate(sources):txt(d,(155,320+k*68),s,27,WHITE)
  p.stdin.write(im.tobytes())
 p.stdin.close();assert p.wait()==0;return dest

def music(seconds):
 # Original, continuously evolving ambient bed. No samples or external recordings.
 path=OUT/'original-score.wav';sr=48000
 chords=[(130.81,155.56,196),(116.54,146.83,174.61),(103.83,130.81,155.56),(98,123.47,146.83),(116.54,155.56,185),(130.81,164.81,196),(110,138.59,164.81),(98,130.81,155.56)]
 with wave.open(str(path),'wb') as out:
  out.setnchannels(2);out.setsampwidth(2);out.setframerate(sr)
  for start in range(math.ceil(seconds)):
   t=np.arange(sr)/sr+start;sig=np.zeros((sr,2))
   pos=t/14;idx=int(start/14)%len(chords)
   for n in range(max(0,int(start/14)-1),int(start/14)+2):
    local=t-n*14;env=np.clip(local/4,0,1)*np.clip((19-local)/5,0,1);env=np.sin(env*np.pi/2)**2
    for j,f in enumerate(chords[n%len(chords)]):
     v=np.sin(2*np.pi*f*t+.06*np.sin(t*.17+j))*.027+np.sin(2*np.pi*f*2*t)*.004
     pan=.5+.35*math.sin(n*.74+j);sig[:,0]+=v*env*pan;sig[:,1]+=v*env*(1-pan)
   fade=np.minimum(np.minimum(t/4,(seconds-t)/5),1).clip(0,1);sig*=fade[:,None]
   out.writeframes((np.clip(sig,-1,1)*32767).astype('<i2').tobytes())
 return path

def assemble():
 files=[OUT/(b['id']+'.mp4') for b in BLOCKS]
 if not all(p.exists() for p in files):raise RuntimeError('missing render blocks')
 total=sum(float(subprocess.check_output(['ffprobe','-v','error','-show_entries','format=duration','-of','csv=p=0',str(p)])) for p in files)
 outro=max(30,1800-total);files.append(credits(round(outro*25)/25));lst=OUT/'concat.txt';lst.write_text(''.join("file '"+str(p)+"'\n" for p in files))
 joined=OUT/'joined.mp4';subprocess.run(['ffmpeg','-v','error','-y','-f','concat','-safe','0','-i',str(lst),'-c','copy','-movflags','+faststart',str(joined)],check=True)
 length=float(subprocess.check_output(['ffprobe','-v','error','-show_entries','format=duration','-of','csv=p=0',str(joined)]));score=music(length)
 final=ROOT/'Cronicas-y-Misterios-Episodio-01-1080p.mp4'
 fc='[0:a]aformat=channel_layouts=stereo[voice];[1:a]volume=0.35[bed];[voice][bed]amix=inputs=2:duration=first:normalize=0,loudnorm=I=-16:TP=-1:LRA=11[a]'
 subprocess.run(['ffmpeg','-v','warning','-y','-i',str(joined),'-i',str(score),'-filter_complex',fc,'-map','0:v','-map','[a]','-c:v','copy','-c:a','aac','-b:a','192k','-ar','48000','-movflags','+faststart',str(final)],check=True)
 print('FINAL',final,flush=True)

if __name__=='__main__':
 mode=sys.argv[2] if len(sys.argv)>2 else '--previews'
 if mode=='--previews':previews()
 elif mode in ['--visuals','--diagrams']:
  chosen=[b for b in BLOCKS if (b['kind']=='V' or b['id']=='a13') and (mode=='--visuals' or b['id'] not in PHOTO and b['id'] not in ['v01','v27','v28'])]
  with ProcessPoolExecutor(max_workers=3) as ex:list(ex.map(render_visual,chosen))
 elif mode=='--avatars':
  chosen=[b for b in BLOCKS if b['kind']=='A' and b['id']!='a13']
  with ProcessPoolExecutor(max_workers=3) as ex:list(ex.map(render_avatar,chosen))
 elif mode=='--assemble':assemble()
 elif mode.startswith('--one='):render_visual(BM[mode.split('=',1)[1]])
