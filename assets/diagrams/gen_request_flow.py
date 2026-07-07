#!/usr/bin/env python3
"""Generate request-flow.svg (Style 1 Flat Icon, top->bottom request flow)."""

L = []
a = L.append

# Palette (AWS service palette + logo tokens)
EKS = "#ED7100"      # EKS orange
BEDROCK = "#01A88D"  # Bedrock teal
NET = "#8C4FFF"      # network / ALB / VPCE purple
DB = "#527FFF"       # Aurora / DB blue
XACCT = "#DD344C"    # cross-account red
GRAY = "#6B7280"     # client / neutral
INK = "#1F1B16"      # ink
RULE = "#C8C0AE"     # rule

W, H = 960, 800

a(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}">')
a('  <style>')
a("    text { font-family: 'Helvetica Neue', Helvetica, Arial, 'PingFang SC', 'Microsoft YaHei', sans-serif; }")
a('    .title { font-weight: 700; }')
a('    .lbl { font-weight: 600; }')
a('    .sub { font-weight: 400; }')
a('  </style>')

# ---- defs: arrow markers + gradients ----
a('  <defs>')
for name, col in [("gray", GRAY), ("net", NET), ("eks", EKS), ("bedrock", BEDROCK),
                  ("db", DB), ("xacct", XACCT), ("red", XACCT)]:
    a(f'    <marker id="ar-{name}" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">')
    a(f'      <polygon points="0 0, 10 3.5, 0 7" fill="{col}"/>')
    a('    </marker>')
# soft shadow
a('    <filter id="soft" x="-20%" y="-20%" width="140%" height="140%">')
a(f'      <feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="{INK}" flood-opacity="0.12"/>')
a('    </filter>')
a('  </defs>')

# ---- background ----
a(f'  <rect width="{W}" height="{H}" fill="#ffffff"/>')

# ---- title ----
a(f'  <text x="40" y="46" class="title" font-size="22" fill="{INK}">LiteLLM &#8594; Bedrock Gateway &#183; Request Flow</text>')
a(f'  <text x="40" y="68" class="sub" font-size="13" fill="{GRAY}">Happy path: client &#8594; ALB/WAF &#8594; LiteLLM pod (auth) &#8594; Bedrock InvokeModel &#8594; stream back &#183; async spend log</text>')
a(f'  <line x1="40" y1="80" x2="920" y2="80" stroke="{RULE}" stroke-width="1"/>')


def box(x, y, w, h, fill, stroke, title, sub1=None, sub2=None, sub3=None, tag=None, tagcol=None):
    """Rounded-rect service node."""
    a(f'  <g filter="url(#soft)">')
    a(f'    <rect x="{x}" y="{y}" width="{w}" height="{h}" rx="8" ry="8" fill="{fill}" stroke="{stroke}" stroke-width="1.5"/>')
    a(f'  </g>')
    # accent bar on left
    a(f'  <rect x="{x}" y="{y}" width="5" height="{h}" rx="2.5" fill="{stroke}"/>')
    cx = x + w / 2
    ty = y + 24
    a(f'    <text x="{cx}" y="{ty}" text-anchor="middle" class="lbl" font-size="15" fill="{INK}">{title}</text>')
    yy = ty + 19
    for s in (sub1, sub2, sub3):
        if s:
            a(f'    <text x="{cx}" y="{yy}" text-anchor="middle" class="sub" font-size="11.5" fill="{GRAY}">{s}</text>')
            yy += 16
    if tag:
        a(f'    <rect x="{x+w-64}" y="{y+8}" width="56" height="18" rx="9" fill="{tagcol}" opacity="0.14"/>')
        a(f'    <text x="{x+w-36}" y="{y+21}" text-anchor="middle" font-size="10" class="lbl" fill="{tagcol}">{tag}</text>')


def lbl_on_line(x, y, text, col, w=None):
    """Arrow label with background rect."""
    if w is None:
        w = 8 + len(text) * 6.4
    a(f'  <rect x="{x-w/2}" y="{y-11}" width="{w}" height="18" rx="4" fill="#ffffff" stroke="{col}" stroke-width="0.8" opacity="0.95"/>')
    a(f'  <text x="{x}" y="{y+2}" text-anchor="middle" font-size="10.5" class="lbl" fill="{col}">{text}</text>')


# ======================= NODES =======================
# Column geometry: main happy-path column centered ~ x=380 (width 320 boxes)
CX = 260          # left edge of main boxes
BW = 300          # box width
midx = CX + BW/2  # 410

# 1. Client (top)
box(CX, 100, BW, 66, "#f9fafb", GRAY,
    "Client (Tokyo, public)",
    "POST /v1/messages  |  /v1/chat/completions",
    "header: x-api-key = sk-... (virtual key)")

# 2. ALB + WAF
box(CX, 210, BW, 74, "#faf5ff", NET,
    "ALB  +  AWS WAF",
    "WAF rules check &#183; TLS (ACM)",
    "idle timeout 600s (streaming-safe)",
    tag="L7", tagcol=NET)

# 3. LiteLLM pod (hexagon gateway) - drawn separately below as hexagon
# We'll place a rect-ish region; but skill: hexagon=gateway. Draw hexagon.
HEX_Y = 320
HEX_H = 96
HEX_W = 300
hx = CX
hy = HEX_Y
# hexagon points (horizontal hex)
p = [
    (hx+22, hy),
    (hx+HEX_W-22, hy),
    (hx+HEX_W, hy+HEX_H/2),
    (hx+HEX_W-22, hy+HEX_H),
    (hx+22, hy+HEX_H),
    (hx, hy+HEX_H/2),
]
pts = " ".join(f"{px:.0f},{py:.0f}" for px, py in p)
a(f'  <g filter="url(#soft)">')
a(f'    <polygon points="{pts}" fill="#fff7ed" stroke="{EKS}" stroke-width="1.8"/>')
a(f'  </g>')
hcx = hx + HEX_W/2
a(f'    <text x="{hcx}" y="{hy+26}" text-anchor="middle" class="lbl" font-size="15" fill="{INK}">LiteLLM Gateway Pod</text>')
a(f'    <text x="{hcx}" y="{hy+44}" text-anchor="middle" class="sub" font-size="11.5" fill="{GRAY}">EKS 1.31 &#183; 2 replicas &#183; v1.88.1</text>')
a(f'    <text x="{hcx}" y="{hy+60}" text-anchor="middle" class="sub" font-size="11.5" fill="{GRAY}">drop_params &#183; thinking params by model gen</text>')
a(f'    <text x="{hcx}" y="{hy+78}" text-anchor="middle" class="sub" font-size="11.5" fill="{GRAY}">virtual-key auth</text>')

# 4. Decision diamond: auth valid?
DY = 470
dcx = midx
dcy = DY + 55
dw = 130
dh = 66
dpts = f"{dcx},{dcy-dh/2} {dcx+dw/2},{dcy} {dcx},{dcy+dh/2} {dcx-dw/2},{dcy}"
a(f'  <g filter="url(#soft)">')
a(f'    <polygon points="{dpts}" fill="#ffffff" stroke="{GRAY}" stroke-width="1.6"/>')
a(f'  </g>')
a(f'    <text x="{dcx}" y="{dcy-4}" text-anchor="middle" class="lbl" font-size="13" fill="{INK}">auth</text>')
a(f'    <text x="{dcx}" y="{dcy+13}" text-anchor="middle" class="lbl" font-size="13" fill="{INK}">valid?</text>')

# 4b. 401 reject (to the right of diamond)
box(690, DY+22, 210, 66, "#fef2f2", XACCT,
    "401 Unauthorized",
    "invalid / missing key",
    "request rejected")

# 5. Pod Identity creds (left side, feeding the InvokeModel step)
box(20, 600, 210, 76, "#fff7ed", EKS,
    "Pod Identity",
    "injects short-lived",
    "IAM creds (no static keys)")

# 6. Bedrock InvokeModel
box(CX, 600, BW, 90, "#f0fdfa", BEDROCK,
    "Bedrock InvokeModel",
    "claude-sonnet-4-6 &#183; streaming",
    "global.*  |  us.* (peering)",
    "cross-account AssumeRole+TagSession",
    tag="4 LAYER", tagcol=BEDROCK)

# 7. Stream response back (right side going up)
box(690, 610, 210, 70, "#f0fdfa", BEDROCK,
    "Stream response",
    "SSE tokens &#8594; client",
    "(via pod &#8594; ALB)")

# 8. Aurora (async spend log) - cylinder DB bottom
def cylinder(cx, top, w, h, fill, stroke, title, sub):
    rx = w/2
    ry = 12
    x0 = cx - rx
    a(f'  <g filter="url(#soft)">')
    a(f'    <path d="M {x0} {top+ry} a {rx} {ry} 0 0 1 {w} 0 l 0 {h} a {rx} {ry} 0 0 1 {-w} 0 Z" fill="{fill}" stroke="{stroke}" stroke-width="1.5"/>')
    a(f'    <ellipse cx="{cx}" cy="{top+ry}" rx="{rx}" ry="{ry}" fill="{fill}" stroke="{stroke}" stroke-width="1.5"/>')
    a(f'  </g>')
    a(f'    <text x="{cx}" y="{top+h/2+8}" text-anchor="middle" class="lbl" font-size="13.5" fill="{INK}">{title}</text>')
    a(f'    <text x="{cx}" y="{top+h/2+26}" text-anchor="middle" class="sub" font-size="11" fill="{GRAY}">{sub}</text>')

cylinder(410, 712, 200, 60, "#eef3ff", DB, "Aurora PostgreSQL", "Serverless v2 &#183; spend logs")


# ======================= EDGES =======================
# Helper: vertical arrow with animated dot on happy path
def varrow(x, y1, y2, col, marker, animate=False, dur="2.4s", begin="0s"):
    a(f'  <line x1="{x}" y1="{y1}" x2="{x}" y2="{y2}" stroke="{col}" stroke-width="2" marker-end="url(#ar-{marker})"/>')
    if animate:
        a(f'    <circle r="4.5" fill="{col}">')
        a(f'      <animate attributeName="cx" values="{x};{x}" dur="{dur}" repeatCount="indefinite"/>')
        a(f'      <animate attributeName="cy" values="{y1};{y2-8}" dur="{dur}" begin="{begin}" repeatCount="indefinite"/>')
        a(f'      <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.12;0.85;1" dur="{dur}" begin="{begin}" repeatCount="indefinite"/>')
        a('    </circle>')

# 1 -> 2 client to ALB
varrow(midx, 166, 210, GRAY, "gray", animate=True, dur="2.4s", begin="0s")
lbl_on_line(midx, 190, "HTTPS + x-api-key", GRAY)

# 2 -> 3 ALB to LiteLLM (hexagon)
varrow(midx, 284, 320, NET, "net", animate=True, dur="2.4s", begin="0.3s")
lbl_on_line(midx, 303, "forward request", NET)

# 3 -> diamond (hex bottom to diamond top)
varrow(midx, 416, DY+22, EKS, "eks", animate=True, dur="2.4s", begin="0.6s")

# diamond -> 401 (right, NO branch)
a(f'  <path d="M {dcx+dw/2} {dcy} H 690" stroke="{XACCT}" stroke-width="2" fill="none" marker-end="url(#ar-xacct)"/>')
lbl_on_line(620, dcy-2, "no", XACCT, w=34)

# diamond -> Bedrock (down, YES branch)
varrow(midx, dcy+dh/2, 600, EKS, "eks", animate=True, dur="2.4s", begin="0.9s")
lbl_on_line(midx, 560, "yes &#183; authorized", EKS)

# Pod Identity -> Bedrock (creds inject, horizontal)
a(f'  <path d="M 230 645 H {CX}" stroke="{EKS}" stroke-width="2" fill="none" stroke-dasharray="5,3" marker-end="url(#ar-eks)"/>')
lbl_on_line(245, 632, "creds", EKS, w=48)

# Bedrock -> stream response (right/up). Bedrock right edge -> stream box left
a(f'  <path d="M {CX+BW} 645 H 690" stroke="{BEDROCK}" stroke-width="2" fill="none" marker-end="url(#ar-bedrock)"/>')
lbl_on_line(618, 634, "tokens", BEDROCK, w=54)

# stream response -> up to client (long return path on right edge)
a(f'  <path d="M 795 610 V 133 H {CX+BW}" stroke="{BEDROCK}" stroke-width="2" fill="none" marker-end="url(#ar-bedrock)"/>')
lbl_on_line(795, 380, "stream response to client", BEDROCK)
# animated return dot
a(f'    <circle r="4.5" fill="{BEDROCK}">')
a('      <animateMotion path="M 795 610 V 133 H 560" dur="2.8s" begin="1.4s" repeatCount="indefinite"/>')
a('      <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.1;0.9;1" dur="2.8s" begin="1.4s" repeatCount="indefinite"/>')
a('    </circle>')

# Bedrock / LiteLLM -> Aurora async spend log (down)
varrow(410, 690, 712, DB, "db")
lbl_on_line(410, 704, "async: spend log", DB)
# animated async dot (dashed feel via slower)
a(f'    <circle r="4" fill="{DB}">')
a('      <animate attributeName="cx" values="410;410" dur="3s" begin="1.8s" repeatCount="indefinite"/>')
a('      <animate attributeName="cy" values="690;706" dur="3s" begin="1.8s" repeatCount="indefinite"/>')
a('      <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.15;0.8;1" dur="3s" begin="1.8s" repeatCount="indefinite"/>')
a('    </circle>')

# subtle pulse on the gateway hexagon (opacity 0.6->1, start complete)
# add a pulsing accent ring
a(f'  <polygon points="{pts}" fill="none" stroke="{EKS}" stroke-width="2" opacity="0.9">')
a('    <animate attributeName="opacity" values="0.9;0.35;0.9" dur="3s" repeatCount="indefinite"/>')
a('  </polygon>')


# ======================= LEGEND =======================
lx, ly = 40, 720
a(f'  <rect x="{lx-12}" y="{ly-18}" width="196" height="72" rx="8" fill="#ffffff" stroke="{RULE}" stroke-width="1"/>')
a(f'  <text x="{lx}" y="{ly-2}" class="lbl" font-size="11" fill="{INK}">LEGEND</text>')
leg = [
    (GRAY, "gray", "client request"),
    (NET, "net", "ALB / WAF forward"),
    (EKS, "eks", "gateway / auth path"),
    (BEDROCK, "bedrock", "Bedrock invoke / stream"),
]
yy = ly + 14
for col, m, txt in leg:
    a(f'  <line x1="{lx}" y1="{yy}" x2="{lx+26}" y2="{yy}" stroke="{col}" stroke-width="2" marker-end="url(#ar-{m})"/>')
    a(f'  <text x="{lx+34}" y="{yy+4}" font-size="10.5" fill="{GRAY}">{txt}</text>')
    yy += 15.5

a('</svg>')

out = "request-flow.svg"
with open(out, "w") as f:
    f.write("\n".join(L) + "\n")
print("wrote", out, len(L), "lines")
