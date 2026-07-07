#!/usr/bin/env python3
"""Generate the four-layer LiteLLM->Bedrock-on-EKS architecture diagram.
Style 3 Blueprint (#0a1628) + AWS service palette. viewBox 960x760.
Assembled via the Python-list method (append each SVG line)."""

W, H = 960, 760
s = []
a = s.append

# --- palette (AWS service colors from logo) ---
EKS = "#ED7100"      # EKS orange
BEDROCK = "#01A88D"  # Bedrock teal
NET = "#8C4FFF"      # network / ALB / VPCE purple
DB = "#527FFF"       # Aurora / DB blue
XACC = "#DD344C"     # cross-account red
GRAY = "#6B7280"     # client / neutral
INK = "#caf0f8"      # blueprint light text
CYAN = "#00b4d8"     # blueprint accent
PANEL = "#0d1f3c"
BG = "#0a1628"

a(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}">')

# ---- styles ----
a('<style>')
a("  text { font-family: 'Courier New','Lucida Console','Microsoft YaHei','SimHei',monospace; fill:#caf0f8; }")
a('  .title { font-weight:700; letter-spacing:0.06em; }')
a('  .lbl { font-size:13px; }')
a('  .sub { font-size:10px; fill:#90e0ef; }')
a('  .ann { font-size:9.5px; fill:#48cae4; }')
a('  .layer { font-size:11px; font-weight:700; letter-spacing:0.12em; }')
a('</style>')

# ---- defs: grid + arrow markers + glows ----
a('<defs>')
a('  <pattern id="grid" width="30" height="30" patternUnits="userSpaceOnUse">')
a('    <path d="M 30 0 L 0 0 0 30" fill="none" stroke="#112240" stroke-width="0.5"/>')
a('  </pattern>')
def marker(mid, col):
    a(f'  <marker id="{mid}" markerWidth="9" markerHeight="7" refX="7.5" refY="3.5" orient="auto">')
    a(f'    <polygon points="0 0, 9 3.5, 0 7" fill="{col}"/>')
    a('  </marker>')
marker("aBed", BEDROCK)
marker("aNet", NET)
marker("aEks", EKS)
marker("aDb", DB)
marker("aXacc", XACC)
marker("aGray", GRAY)
a(f'  <filter id="soft" x="-40%" y="-40%" width="180%" height="180%"><feDropShadow dx="0" dy="2" stdDeviation="4" flood-color="#000" flood-opacity="0.45"/></filter>')
a('</defs>')

# ---- background ----
a(f'<rect width="{W}" height="{H}" fill="{BG}"/>')
a(f'<rect width="{W}" height="{H}" fill="url(#grid)" opacity="0.6"/>')

# ---- title (top-left) ----
a(f'<text x="30" y="40" class="title" font-size="20" fill="{INK}">LiteLLM <tspan fill="{BEDROCK}">&#8594; Bedrock</tspan> Gateway on EKS</text>')
a(f'<text x="30" y="58" class="sub" fill="{CYAN}">FOUR-LAYER ARCHITECTURE &#183; L1 public &#183; L2 same-region VPCE &#183; L3 cross-region peering &#183; L4 cross-account</text>')

# ---------------------------------------------------------------
# Helper: rounded technical box with colored accent stroke
# ---------------------------------------------------------------
def box(x, y, w, h, stroke, title, sub=None, sub2=None, fill=PANEL, rx=3, tsize=13):
    a(f'<g filter="url(#soft)">')
    a(f'  <rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}" stroke="{stroke}" stroke-width="1.5"/>')
    a('</g>')
    # left accent bar
    a(f'<rect x="{x}" y="{y}" width="4" height="{h}" rx="2" fill="{stroke}"/>')
    cx = x + w/2
    if sub and sub2:
        a(f'<text x="{cx}" y="{y+h/2-9}" text-anchor="middle" class="lbl" font-size="{tsize}" font-weight="700">{title}</text>')
        a(f'<text x="{cx}" y="{y+h/2+6}" text-anchor="middle" class="sub">{sub}</text>')
        a(f'<text x="{cx}" y="{y+h/2+19}" text-anchor="middle" class="sub" fill="#48cae4">{sub2}</text>')
    elif sub:
        a(f'<text x="{cx}" y="{y+h/2-3}" text-anchor="middle" class="lbl" font-size="{tsize}" font-weight="700">{title}</text>')
        a(f'<text x="{cx}" y="{y+h/2+13}" text-anchor="middle" class="sub">{sub}</text>')
    else:
        a(f'<text x="{cx}" y="{y+h/2+4}" text-anchor="middle" class="lbl" font-size="{tsize}" font-weight="700">{title}</text>')

def hexagon(cx, cy, r, stroke, fill=PANEL):
    import math
    pts = []
    for i in range(6):
        ang = math.pi/180*(60*i - 30)
        pts.append(f"{cx + r*math.cos(ang):.1f},{cy + r*0.9*math.sin(ang):.1f}")
    a(f'<polygon points="{" ".join(pts)}" fill="{fill}" stroke="{stroke}" stroke-width="1.5" filter="url(#soft)"/>')

def dashed_container(x, y, w, h, stroke, label, lx=None):
    a(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="6" fill="none" stroke="{stroke}" stroke-width="1.3" stroke-dasharray="7,4" opacity="0.85"/>')
    lx = lx if lx is not None else x+10
    a(f'<text x="{lx}" y="{y+15}" class="layer" fill="{stroke}">{label}</text>')

# ---------------------------------------------------------------
# LAYER LABELS (left rail)
# ---------------------------------------------------------------
def rail(y, txt, col):
    a(f'<text x="12" y="{y}" class="ann" fill="{col}" transform="rotate(-90 12 {y})" font-weight="700">{txt}</text>')

# ===============================================================
# NODES
# ===============================================================
midx = 300  # center column x for client/ALB/EKS

# --- CLIENT (top) ---
cx0 = midx - 110
box(cx0, 80, 220, 52, GRAY, "Client", "app / Claude Code / scripts")
# client id badge
a(f'<circle cx="{midx}" cy="106" r="0" />')

# --- ALB + WAF (region VPC public/edge) ---
alb_y = 176
box(midx-160, alb_y, 210, 66, NET, "ALB (Application LB)",
    "idle timeout 600s", "internal-by-default")
box(midx+70, alb_y, 90, 66, NET, "WAF", "WebACL", fill="#161033")
# note under ALB
a(f'<text x="{midx-55}" y="{alb_y+80}" text-anchor="middle" class="ann" fill="{EKS}">internet-facing REQUIRES ACM cert &#183; no HTTP:80 &#183; 0.0.0.0/0 rejected x4</text>')

# --- EKS cluster (hexagon gateway pods) ---
eks_y = 300
eks_x = midx-170
eks_w = 340
eks_h = 118
a(f'<rect x="{eks_x}" y="{eks_y}" width="{eks_w}" height="{eks_h}" rx="6" fill="#1a0f00" stroke="{EKS}" stroke-width="1.6"/>')
a(f'<rect x="{eks_x}" y="{eks_y}" width="4" height="{eks_h}" rx="2" fill="{EKS}"/>')
a(f'<text x="{eks_x+16}" y="{eks_y+22}" class="lbl" font-weight="700" fill="{EKS}">EKS 1.31 cluster</text>')
a(f'<text x="{eks_x+eks_w-14}" y="{eks_y+22}" text-anchor="end" class="ann" fill="{EKS}">Pod Identity &#8594; injects creds</text>')
# two LiteLLM pods as hexagons
for i, hx in enumerate([eks_x+95, eks_x+245]):
    hexagon(hx, eks_y+72, 42, BEDROCK, fill="#08221d")
    a(f'<text x="{hx}" y="{eks_y+68}" text-anchor="middle" class="sub" fill="{BEDROCK}" font-weight="700">LiteLLM</text>')
    a(f'<text x="{hx}" y="{eks_y+82}" text-anchor="middle" class="ann" fill="#48cae4">v1.88.1 pod{i+1}</text>')
a(f'<text x="{eks_x+eks_w/2}" y="{eks_y+eks_h-8}" text-anchor="middle" class="ann" fill="{BEDROCK}">2 replicas &#183; virtual keys + spend logs</text>')

# --- Aurora (right of EKS) ---
aur_x = 720
aur_y = 312
aur_w = 200
aur_h = 92
# cylinder
cyl_rx = aur_w/2
a(f'<g filter="url(#soft)">')
a(f'  <path d="M{aur_x} {aur_y+14} a{cyl_rx} 14 0 0 1 {aur_w} 0 v{aur_h-28} a{cyl_rx} 14 0 0 1 -{aur_w} 0 Z" fill="#0a1b3d" stroke="{DB}" stroke-width="1.6"/>')
a(f'  <path d="M{aur_x} {aur_y+14} a{cyl_rx} 14 0 0 0 {aur_w} 0" fill="none" stroke="{DB}" stroke-width="1.6"/>')
a('</g>')
a(f'<text x="{aur_x+cyl_rx}" y="{aur_y+46}" text-anchor="middle" class="lbl" font-weight="700" fill="{DB}">Aurora PostgreSQL</text>')
a(f'<text x="{aur_x+cyl_rx}" y="{aur_y+62}" text-anchor="middle" class="sub" fill="{DB}">Serverless v2 &#183; spend logs</text>')

# ===============================================================
# EGRESS LAYER containers (bottom) : A / B / C
# ===============================================================
ey = 470
eh = 210

# --- (A) L2 same-region VPCE -> Bedrock ---
ax = 40
aw = 270
dashed_container(ax, ey, aw, eh, BEDROCK, "L2 &#183; SAME-REGION VPC")
box(ax+35, ey+40, aw-70, 56, NET, "Bedrock VPCE", "PrivateLink endpoint", fill="#161033")
box(ax+35, ey+128, aw-70, 58, BEDROCK, "Bedrock (region)", "claude-sonnet-4-6")

# --- (B) L3 cross-region peering -> us-west-2 ---
bx = 345
bw = 270
dashed_container(bx, ey, bw, eh, DB, "L3 &#183; CROSS-REGION PEER")
box(bx+30, ey+40, bw-60, 52, DB, "us-west-2 VPC", "via VPC Peering", fill="#0a1b3d")
box(bx+30, ey+100, bw-60, 40, NET, "VPCE", fill="#161033", tsize=12)
box(bx+30, ey+150, bw-60, 44, BEDROCK, "us.* Bedrock", tsize=12)

# --- (C) L4 cross-account AssumeRole -> account B ---
xx = 650
xw = 270
dashed_container(xx, ey, xw, eh, XACC, "L4 &#183; CROSS-ACCOUNT (B)")
box(xx+30, ey+40, xw-60, 56, XACC, "AssumeRole", "+ TagSession", fill="#2a0d12")
box(xx+30, ey+128, xw-60, 58, BEDROCK, "Account B Bedrock", "isolated tenant")

# ===============================================================
# EDGES (orthogonal)
# ===============================================================
def poly(pts, col, marker, dash=None, w=1.8):
    d = f' stroke-dasharray="{dash}"' if dash else ''
    a(f'<polyline points="{pts}" fill="none" stroke="{col}" stroke-width="{w}"{d} marker-end="url(#{marker})"/>')

def elabel(x, y, txt, col, wpx=None):
    wpx = wpx if wpx else len(txt)*6+8
    a(f'<rect x="{x-wpx/2}" y="{y-11}" width="{wpx}" height="15" rx="2" fill="{BG}" opacity="0.9"/>')
    a(f'<text x="{x}" y="{y}" text-anchor="middle" class="ann" fill="{col}">{txt}</text>')

# Client -> ALB
poly(f"{midx},132 {midx},{alb_y}", BEDROCK, "aBed")
elabel(midx+52, 156, "HTTPS request", BEDROCK)
# WAF <-> ALB inspect (short link)
poly(f"{midx+70},{alb_y+33} {midx+50},{alb_y+33}", NET, "aNet", w=1.4)

# ALB -> EKS
poly(f"{midx-55},{alb_y+66} {midx-55},{eks_y}", BEDROCK, "aBed")
elabel(midx-55, 274, "L7 route", BEDROCK)

# EKS -> Aurora (spend logs, blue) - orthogonal to the right
poly(f"{eks_x+eks_w},{eks_y+42} {aur_x-6},{eks_y+42}", DB, "aDb")
elabel((eks_x+eks_w+aur_x)/2, eks_y+34, "spend logs", DB)

# EKS bottom -> three egress paths
eks_bottom = eks_y+eks_h  # 418
# (A) to same-region VPCE
poly(f"{eks_x+70},{eks_bottom} {eks_x+70},{ey-20} {ax+aw/2},{ey-20} {ax+aw/2},{ey+40}", BEDROCK, "aBed")
elabel(ax+aw/2, ey-30, "L2 VPCE", BEDROCK)
# VPCE -> Bedrock (inside A)
poly(f"{ax+aw/2},{ey+96} {ax+aw/2},{ey+128}", BEDROCK, "aBed", w=1.5)

# (B) to cross-region
poly(f"{midx},{eks_bottom} {midx},{ey-40} {bx+bw/2},{ey-40} {bx+bw/2},{ey+40}", DB, "aDb")
elabel(bx+bw/2, ey-50, "L3 peering", DB)
poly(f"{bx+bw/2},{ey+92} {bx+bw/2},{ey+100}", DB, "aDb", w=1.4)
poly(f"{bx+bw/2},{ey+140} {bx+bw/2},{ey+150}", NET, "aNet", w=1.4)

# (C) to cross-account -- route BELOW Aurora (y=ey-25) to avoid the cylinder
poly(f"{eks_x+eks_w-70},{eks_bottom} {eks_x+eks_w-70},{ey-25} {xx+xw/2},{ey-25} {xx+xw/2},{ey+40}", XACC, "aXacc")
elabel(xx+xw/2, ey-35, "L4 AssumeRole", XACC)
poly(f"{xx+xw/2},{ey+96} {xx+xw/2},{ey+128}", XACC, "aXacc", w=1.5)

# ===============================================================
# ANIMATION: data-flow dot (teal) Client->ALB->EKS->Bedrock(A)
# ===============================================================
# teal path waypoints
teal_path = f"M{midx},116 L{midx},{alb_y+10} L{midx},{alb_y+66} L{midx-55},{alb_y+66} L{midx-55},{eks_y+50} L{eks_x+70},{eks_y+50} L{eks_x+70},{ey-20} L{ax+aw/2},{ey-20} L{ax+aw/2},{ey+156}"
a(f'<circle r="5" fill="{BEDROCK}">')
a(f'  <animateMotion path="{teal_path}" dur="3s" repeatCount="indefinite" rotate="auto"/>')
a(f'  <animate attributeName="opacity" values="0;1;1;1;0" keyTimes="0;0.08;0.5;0.92;1" dur="3s" repeatCount="indefinite"/>')
a('</circle>')

# spend-log dot (blue) EKS -> Aurora
blue_path = f"M{eks_x+eks_w},{eks_y+42} L{aur_x},{eks_y+42}"
a(f'<circle r="4.5" fill="{DB}">')
a(f'  <animateMotion path="{blue_path}" dur="2.2s" repeatCount="indefinite"/>')
a(f'  <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.15;0.85;1" dur="2.2s" repeatCount="indefinite"/>')
a('</circle>')

# subtle pod pulse
for hx in [eks_x+95, eks_x+245]:
    a(f'<circle cx="{hx}" cy="{eks_y+72}" r="42" fill="none" stroke="{BEDROCK}" stroke-width="1" opacity="0.5">')
    a(f'  <animate attributeName="opacity" values="0.6;0.15;0.6" dur="2.6s" repeatCount="indefinite"/>')
    a('</circle>')

# ===============================================================
# LEGEND (bottom-left title-block style, 6 categories)
# ===============================================================
lx, ly = 40, 700
a(f'<rect x="{lx}" y="{ly}" width="640" height="46" rx="3" fill="{PANEL}" stroke="{CYAN}" stroke-width="1"/>')
a(f'<text x="{lx+12}" y="{ly+16}" class="ann" fill="{CYAN}" font-weight="700">LEGEND</text>')
legend = [
    (EKS, "EKS compute"),
    (BEDROCK, "Bedrock / data flow"),
    (NET, "Network / ALB / VPCE"),
    (DB, "Aurora / spend logs"),
    (XACC, "Cross-account"),
    (GRAY, "Client / neutral"),
]
col_x = lx+90
step = 92
for i, (col, txt) in enumerate(legend):
    gx = col_x + (i % 3)*180
    gy = ly + 16 + (i // 3)*20
    a(f'<rect x="{gx}" y="{gy-9}" width="14" height="10" rx="2" fill="{col}"/>')
    a(f'<text x="{gx+20}" y="{gy}" class="ann" fill="{INK}">{txt}</text>')

# ---- title block (bottom-right) ----
tbx, tby = 700, 700
a(f'<rect x="{tbx}" y="{tby}" width="220" height="46" rx="3" fill="{PANEL}" stroke="{CYAN}" stroke-width="1"/>')
a(f'<line x1="{tbx}" y1="{tby+16}" x2="{tbx+220}" y2="{tby+16}" stroke="{CYAN}" stroke-width="0.5"/>')
a(f'<text x="{tbx+110}" y="{tby+12}" text-anchor="middle" class="ann" fill="{INK}">SYSTEM ARCHITECTURE</text>')
a(f'<text x="{tbx+110}" y="{tby+35}" text-anchor="middle" class="title" font-size="13" fill="{CYAN}">LITELLM &#8594; BEDROCK / EKS</text>')

a('</svg>')

with open("/Users/jiasunm/Code/simple-litellm-bedrock-gateway-on-eks/assets/diagrams/architecture.svg", "w") as f:
    f.write("\n".join(s))
print("lines:", len(s))
