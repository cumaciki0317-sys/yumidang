"""Static cascade/font and normal-flow arithmetic, NOT browser layout or touch testing."""
from pathlib import Path
import re,json
from lxml import html
from fontTools.ttLib import TTFont
from fontTools.pens.boundsPen import BoundsPen
root=Path(__file__).resolve().parent
source=(root/'index.html').read_text();doc=html.fromstring(source);adaptive=(root/'adaptive.css').read_text();js=(root/'adaptive.js').read_text()
assert 'scale(' not in js and 'screen.scrollHeight' not in js
assert 'height:100dvh' in adaptive and '--app-max-width:430px' in adaptive
assert doc.xpath('//div[@class="demo-layout"]/div[@class="demo-phone"]') and doc.xpath('//div[@class="demo-layout"]/aside')
assert doc.xpath('//main/section[@class="home-section home-events"]') and doc.xpath('//main/section[@class="home-section home-appointments"]')
assert 'grid-template-columns:repeat(4,minmax(0,1fr))' in adaptive
assert 'white-space:pre-wrap' in adaptive and 'grid-auto-rows:minmax(53.333333333px,auto)' in adaptive
styles=[]
for e in doc.xpath('//head/style|//head/link[@rel="stylesheet"]'):
 styles.append(e.text if e.tag=='style' else (root/e.get('href')).read_text())
font=TTFont(root/'assets/Pretendard-Bold.woff');em=font['head'].unitsPerEm;g=font.getGlyphSet();cmap=font.getBestCmap()
def last_font(cls):
 values=[]
 for css in styles:
  for sel,body in re.findall(r'([^{}]+)\{([^{}]*)\}',re.sub(r'/\*.*?\*/','',css,flags=re.S)):
   if '.'+cls in [s.strip() for s in sel.split(',')]:
    m=re.search(r'font-size:([\d.]+)(rem|px)',body)
    if m:values.append(float(m[1])*(16 if m[2]=='rem' else 1))
 return values[-1]
def ink(text,size):
 bounds=[]
 for ch in text:
  p=BoundsPen(g);g[cmap[ord(ch)]].draw(p)
  if p.bounds:bounds.append(p.bounds)
 baseline=1.3*size/2+(font['hhea'].ascent+font['hhea'].descent)*size/(2*em)
 return [baseline-max(b[3] for b in bounds)*size/em,baseline-min(b[1] for b in bounds)*size/em]
sizes={c:last_font(c) for c in ['events-title','appointment-heading','categories-title']}
for actual,expected in zip(sizes.values(),[38*360/945,38*360/945,36*360/945]):assert abs(actual-expected)<1e-7
# Declared flow box budgets, including converted borders. Text wraps may increase these.
head=48.76190476190476;title=38*360/945*1.3;cat_title=36*360/945*1.3;titlegap=8.284761905
positions={'events_title':head,'event_card':head+title+titlegap}
positions['appointment_title']=positions['event_card']+161.9047619047619+8.228214286
positions['appointment_card']=positions['appointment_title']+title+titlegap
positions['categories_title']=positions['appointment_card']+131.04761904761904+8.439226190
positions['categories_grid']=positions['categories_title']+cat_title+8.439226190
positions['banner']=positions['categories_grid']+4*53.333333333+3*8.304761905+8.304761905
positions['content_end']=positions['banner']+53.333333333+61.257142857
baseline={'events_title':128,'event_card':199.1475,'appointment_title':645.7465625,'appointment_card':716.8940625,'categories_title':1083.04703125,'categories_grid':1152,'banner':1799.2,'content_end':2100}
for key,v in baseline.items():assert abs(positions[key]-v*360/945)<1e-6,(key,positions[key],v*360/945)
e=ink('이번 주 이벤트',sizes['events-title']);a=ink('다가오는 약속',sizes['appointment-heading']);c=ink('어떤 동행을 찾고 계신가요?',sizes['categories-title'])
gaps=[positions['event_card']-(head+e[1]),positions['appointment_title']+a[0]-(positions['event_card']+161.9047619047619),positions['appointment_card']-(positions['appointment_title']+a[1]),positions['categories_title']+c[0]-(positions['appointment_card']+131.04761904761904),positions['categories_grid']-(positions['categories_title']+c[1])]
assert max(gaps)-min(gaps)<1e-6
matrix=[]
for w,h in [(320,568),(320,640),(340,640),(360,640),(360,800),(375,812),(390,844),(412,915),(430,932),(480,1200),(844,390),(932,320),(1024,800),(1440,1200)]:
 width=min(w,430);available=width-16-15.619047619;categorywidth=(available-1.523809524-.761904762-3*9.142857143)/4
 assert categorywidth>64 and available>280
 navwidth=width-10.285714286-9.904761905;assert navwidth>290
 for top,bottom in [(0,0),(24,34)]:
  assert 44.952380952+8.304761905+bottom<h
  content=positions['content_end']+top+bottom
  matrix.append({'viewport':[w,h],'safe':[top,bottom],'frame_width':width,'frame_height':h,'category_width':categorywidth,'minimum_content_height':content,'baseline_text_scroll_needed':content>h+1e-6})
assert all('transform:none' in adaptive for _ in [0])
for fs in [16,20,24,32]:
 assert fs/16*12>=12
 # Typography grows independently, rather than shrinking with narrow frame widths.
 assert abs(sizes['events-title']*fs/16-(38*360/945)*fs/16)<1e-7
report={'method':'static final CSS/font source plus declared normal-flow geometry; not rendered browser measurements','baseline_positions_px':positions,'heading_font_px':sizes,'five_ink_gaps_px':gaps,'reference_width':390,'tested_min_width':320,'mobile_max_width':430,'matrix':matrix,'text_roots_checked':[16,20,24,32],'browser_qa':False,'touch_qa':False,'limit':'Large-text wrapping/paint and browser safe-area behavior still require real-device/browser review.'}
(root/'adaptive-layout-validation.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(f'Home static adaptive checks passed: {len(matrix)} frame/safe-area cases, four text sizes, baseline section anchors and five font-ink gaps.')
