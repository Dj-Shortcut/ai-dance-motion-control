"""Rebuild RIG's original public brand graphics (requires Pillow). No user media."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import math

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'branding'
OUT.mkdir(exist_ok=True)
FONT = ROOT / 'fonts/NotoSans-Regular.ttf'
MINT = '#85e0bb'
DARK = '#111416'
S = 2

def font(size):
    return ImageFont.truetype(str(FONT), size * S)

def text(draw, xy, value, size, fill, bold=False):
    draw.text((xy[0]*S, xy[1]*S), value, font=font(size), fill=fill,
              stroke_width=S if bold else 0, stroke_fill=fill)

def box(draw, rect, fill, radius=16, outline=None, width=1):
    draw.rounded_rectangle(tuple(round(x*S) for x in rect), radius=radius*S,
                           fill=fill, outline=outline, width=width*S)

# A path-based R stays crisp in a browser tab without external fonts.
(OUT/'favicon.svg').write_text('''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><title>RIG</title><rect width="64" height="64" rx="16" fill="#111416"/><path d="M16 14h17c9 0 14 4 14 12 0 6-3 10-9 12l11 12H38L24 34v16h-8V14zm8 8v9h9c4 0 6-1 6-5s-2-4-6-4h-9z" fill="#eef5f1"/><circle cx="53" cy="50" r="4" fill="#85e0bb"/></svg>\n''')
icon = Image.new('RGBA', (512,512))
d = ImageDraw.Draw(icon)
d.rounded_rectangle((0,0,511,511),128,fill=DARK)
scale=8
def poly(points, fill): d.polygon([(x*scale,y*scale) for x,y in points],fill=fill)
d.rectangle((16*scale,14*scale,24*scale,50*scale),fill='#eef5f1')
d.rounded_rectangle((16*scale,14*scale,47*scale,38*scale),11*scale,fill='#eef5f1')
d.rounded_rectangle((24*scale,22*scale,39*scale,31*scale),4*scale,fill=DARK)
poly([(27,31),(38,34),(49,50),(38,50),(24,34)],'#eef5f1')
d.ellipse((49*scale,46*scale,57*scale,54*scale),fill=MINT)
icon.save(OUT/'favicon.ico',format='ICO',sizes=[(16,16),(32,32),(48,48),(64,64)])
icon.resize((180,180),Image.Resampling.LANCZOS).save(OUT/'apple-touch-icon.png',optimize=True)

# An editorial, fully original illustration rather than a generated video claim.
im = Image.new('RGB',(1200*S,630*S),DARK)
pixels=im.load()
for y in range(630*S):
    for x in range(1200*S):
        glow=max(0,1-math.hypot((x/S-1000)/620,(y/S-300)/470))
        pixels[x,y]=(17+round(glow*9),20+round(glow*25),22+round(glow*17))
d=ImageDraw.Draw(im)
for x in range(650,1201,70):
    d.line((x*S,0,x*S,630*S),fill='#22312c',width=1)
text(d,(68,38),'RIG',48,'#eef5f1',True)
w=d.textlength('RIG',font=font(48))
d.ellipse((68*S+w+9*S,83*S,68*S+w+17*S,91*S),fill=MINT)
text(d,(68,147),'Zet je foto',68,'#eef5f1',True)
text(d,(68,228),'in beweging.',68,MINT,True)
text(d,(71,343),'Eén foto + één voorbeeldvideo.',25,'#b2c3b9')
text(d,(71,385),'Jouw idee wordt jouw video.',25,'#b2c3b9')
box(d,(70,497,254,543),'#1c332a',24,outline='#345c49')
text(d,(93,504),'Prijs vooraf',19,MINT)
text(d,(71,566),'AI-videostudio',17,'#82978b')

# Photo and video cards share the same drawn character, with a different pose.
def card(width,height,background,pose,label):
    layer=Image.new('RGBA',(width*S,height*S))
    c=ImageDraw.Draw(layer)
    box(c,(1,1,width-1,height-1),background,24,outline='#86a796')
    cx=width/2
    if pose=='still':
        box(c,(21,23,width-21,height-62),'#e6bfa7',16)
        c.ellipse(((cx-34)*S,53*S,(cx+34)*S,121*S),fill='#3c5148')
        box(c,(cx-62,127,cx+62,height-62),'#3c5148',44)
        c.arc(((cx-19)*S,77*S,(cx+19)*S,101*S),0,175,fill='#a8d8bd',width=3*S)
    else:
        c.ellipse(((cx-27)*S,47*S,(cx+27)*S,101*S),fill='#d9f5e7')
        for offset,color in [(-20,'#3a705c'),(-10,'#568c72')]:
            c.line(((cx-15+offset)*S,123*S,(cx-73+offset)*S,156*S),fill=color,width=16*S)
            c.line(((cx+15+offset)*S,122*S,(cx+62+offset)*S,84*S),fill=color,width=16*S)
        c.line(((cx-16)*S,120*S,(cx-75)*S,153*S),fill='#d9f5e7',width=19*S)
        c.line(((cx+16)*S,119*S,(cx+67)*S,78*S),fill='#d9f5e7',width=19*S)
        box(c,(cx-25,111,cx+25,193),'#d9f5e7',18)
        c.line(((cx-11)*S,181*S,(cx-55)*S,243*S),fill='#d9f5e7',width=21*S)
        c.line(((cx+9)*S,181*S,(cx+53)*S,225*S),fill='#d9f5e7',width=21*S)
        c.arc((35*S,35*S,(width-33)*S,235*S),200,245,fill=MINT,width=3*S)
    box(c,(15,height-48,width-15,height-14),'#172820',12)
    text(c,(28,height-45),label,13,'#d9f5e7')
    return layer

photo=card(209,292,'#c99e86','still','JE FOTO').rotate(10,Image.Resampling.BICUBIC,expand=True)
video=card(247,344,'#244e3e','move','JOUW VIDEO').rotate(-7,Image.Resampling.BICUBIC,expand=True)
im.paste(photo,(682*S,142*S),photo)
im.paste(video,(889*S,141*S),video)
d=ImageDraw.Draw(im)
# Play mark makes the transformation legible even as a small link thumbnail.
d.ellipse((1072*S,407*S,1140*S,475*S),fill=MINT)
d.polygon([(1099*S,428*S),(1099*S,453*S),(1119*S,440*S)],fill='#173027')
im.resize((1200,630),Image.Resampling.LANCZOS).save(OUT/'rig-share-v1.png',optimize=True)
print('Created favicon.svg, favicon.ico, apple-touch-icon.png and rig-share-v1.png.')
