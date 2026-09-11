"""Create a vector A3 exhibition poster. Requires reportlab and a Chinese TTF font."""
from pathlib import Path
import argparse
import subprocess
from reportlab.pdfgen.canvas import Canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.colors import HexColor
from reportlab.graphics.barcode.qr import QrCodeWidget
from reportlab.graphics.shapes import Drawing
from reportlab.graphics import renderPDF

p = argparse.ArgumentParser()
p.add_argument('--font', default=None)
p.add_argument('--url', default='https://github.com/changer-changer/PilotDeck-Verified-Subtasks')
p.add_argument('--output', default='docs/verified-subtasks/assets/poster-a3.pdf')
a = p.parse_args()
font = a.font or subprocess.check_output(['fc-match', '-f', '%{file}', 'DengXian'], text=True)
pdfmetrics.registerFont(TTFont('CN', font))
target = Path(a.output); target.parent.mkdir(parents=True, exist_ok=True)
W, H = 841.89, 1190.55
c = Canvas(str(target), pagesize=(W,H))
c.setTitle('PilotDeck 子任务验收与局部修复 · 方向三')
c.setAuthor('PilotDeck Verified Subtasks')
ink, cream, green, muted, amber = '#123B34','#F5F3E9','#D2F09B','#A7C4B9','#FFD48B'
def rect(x,y,w,h,color,r=0):
    c.setFillColor(HexColor(color)); c.setStrokeColor(HexColor(color))
    if r: c.roundRect(x,H-y-h,w,h,r,fill=1,stroke=0)
    else: c.rect(x,H-y-h,w,h,fill=1,stroke=0)
def txt(x,y,text,size=16,color=cream,font='CN'):
    c.setFillColor(HexColor(color)); c.setFont(font,size); c.drawString(x,H-y-size,text)
def line(x1,y1,x2,y2,color=muted,width=1):
    c.setStrokeColor(HexColor(color)); c.setLineWidth(width); c.line(x1,H-y1,x2,H-y2)
def arrow(x1,y1,x2,y2,color=muted):
    line(x1,y1,x2,y2,color,2); line(x2-6,y2-4,x2,y2,color,2); line(x2-6,y2+4,x2,y2,color,2)

rect(0,0,W,H,ink)
txt(48,38,'PilotDeck',24,cream,'Helvetica-Bold')
txt(555,45,'方向三 / 底层 Harness 升级',15,muted)
line(48,85,794,85,'#3D5E52')
txt(46,116,'让“完成”',64,cream)
txt(46,194,'经得起验收。',64,green)
txt(49,288,'子任务结果验收 + 局部自动修复',25,cream)
txt(49,334,'结构检查 + 模型复核；只修失败任务；证据可查。',18,muted)

rect(48,393,746,305,cream,14)
txt(69,412,'01  原生 PilotDeck 里的完整执行链',18,ink)
labels=[('正确报表','两层验收通过','保留结果',green),('风险简报','格式对，结论错','同会话修复',amber),('独立复核','读取文件与来源','再次验收',green)]
for i,(name,check,action,color) in enumerate(labels):
    y=459+i*66
    rect(69,y,144,43,ink,8); txt(89,y+9,name,18,cream)
    arrow(225,y+21,264,y+21,ink)
    rect(277,y,186,43,color,8); txt(298,y+10,check,18,ink)
    arrow(476,y+21,514,y+21,ink)
    rect(527,y,242,43,'#E2E8D8',8); txt(548,y+10,action,18,ink)
txt(69,661,'评审看原任务、交付声明与实际文件；默认跟随主对话模型。',15,ink)

txt(49,729,'02  有约束的复核，有边界的修复',18,cream)
for x,num,title in [(49,'2','结构与模型两层验收'),(293,'1','原子任务内修复回路'),(539,'0','评审器写文件权限')]:
    txt(x,769,num,62,green,'Helvetica-Bold')
    txt(x,845,title,17,cream)
txt(49,891,'真实模型复核实际文件；共享轮次预算；异常明确拒绝。',15,muted)
txt(49,916,'另附第一层对照：预置故障中请求 15→9；不代表双层方案总成本。',14,muted)

line(48,962,794,962,'#3D5E52')
txt(49,987,'原生设置可选评审模型 · 判定理由与读取证据留存',17,cream)
txt(49,1022,'基于 OpenBMB/PilotDeck；保留原生界面与工具链。',14,muted)
txt(49,1050,'代码、运行方式、完整实验与已知限制均在公开仓库。',14,muted)
txt(49,1090,'边界：模型复核可能误判且增加成本；无全局回滚。',12,muted)
txt(49,1140,'PILOTDECK VERIFIED SUBTASKS / 2026',11,muted,'Helvetica')

rect(669,983,124,124,'#FFFFFF',4)
qr=QrCodeWidget(a.url,barLevel='M'); bounds=qr.getBounds(); s=112
d=Drawing(s,s,transform=[s/(bounds[2]-bounds[0]),0,0,s/(bounds[3]-bounds[1]),0,0]); d.add(qr)
renderPDF.draw(d,c,675,H-989-s)
txt(677,1117,'扫码查看代码',13,cream)
c.linkURL(a.url,(660,H-1141,800,H-981),relative=0,thickness=0)
c.showPage(); c.save()
print(target)
