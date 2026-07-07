#!/usr/bin/env python3
"""Generate deploy-flow.svg (Style 1 Flat Icon, top->bottom flowchart)."""

W, H = 960, 1320
L = []
a = L.append

# ---- palette (project AWS service palette) ----
EKS = "#ED7100"      # EKS orange
BEDROCK = "#01A88D"  # Bedrock teal
NET = "#8C4FFF"      # network/ALB/VPCE purple
DB = "#527FFF"       # Aurora/DB blue
XACC = "#DD344C"     # cross-account red
GRAY = "#6B7280"     # neutral
INK = "#1F1B16"      # ink
RULE = "#C8C0AE"     # rule
BOXSTROKE = "#d1d5db"

a(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}">')
a('<style>')
a("  text { font-family: 'Helvetica Neue', Helvetica, Arial, 'PingFang SC', 'Microsoft YaHei', sans-serif; }")
a('  .title { font-weight: 700; }')
a('  .lbl { font-weight: 600; }')
a('  .sub { font-weight: 400; }')
a('  .mono { font-family: "JetBrains Mono", "Courier New", monospace; }')
a('</style>')

a('<defs>')
# arrow markers
for mid, col in [("arrow-main", EKS), ("arrow-ok", BEDROCK), ("arrow-fail", XACC), ("arrow-gray", GRAY)]:
    a(f'<marker id="{mid}" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">')
    a(f'  <polygon points="0 0, 10 3.5, 0 7" fill="{col}"/>')
    a('</marker>')
# gradient bar for header (echo logo)
a('<linearGradient id="hdr" x1="0" y1="0" x2="1" y2="0">')
a(f'  <stop offset="0" stop-color="{NET}"/><stop offset="0.5" stop-color="{DB}"/><stop offset="1" stop-color="{BEDROCK}"/>')
a('</linearGradient>')
a('<filter id="soft" x="-20%" y="-20%" width="140%" height="140%">')
a(f'  <feDropShadow dx="0" dy="1.5" stdDeviation="2.5" flood-color="{INK}" flood-opacity="0.12"/>')
a('</filter>')
a('</defs>')

# background
a(f'<rect width="{W}" height="{H}" fill="#ffffff"/>')

# ---- header ----
a(f'<rect x="0" y="0" width="{W}" height="6" fill="url(#hdr)"/>')
a(f'<text x="480" y="46" text-anchor="middle" class="title" font-size="24" fill="{INK}">Deploy Flow &#8212; LiteLLM &#8594; Bedrock Gateway on EKS</text>')
a(f'<text x="480" y="70" text-anchor="middle" class="sub" font-size="13" fill="{GRAY}">configure &#8594; preflight (fail-fast) &#8594; cdk deploy --all &#8594; post-deploy &#8594; verify E2E</text>')

CX = 300  # main column center x

def box(x, y, w, h, fill, stroke, title, subs, tcol=INK, rx=8, mono_subs=False, tsize=15):
    a(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" ry="{rx}" fill="{fill}" stroke="{stroke}" stroke-width="1.5" filter="url(#soft)"/>')
    cx = x + w/2
    a(f'<text x="{cx}" y="{y+26}" text-anchor="middle" class="lbl" font-size="{tsize}" fill="{tcol}">{title}</text>')
    sy = y + 46
    for s in subs:
        cls = "mono" if mono_subs else "sub"
        a(f'<text x="{cx}" y="{sy}" text-anchor="middle" class="{cls}" font-size="11.5" fill="{GRAY}">{s}</text>')
        sy += 16

def diamond(cx, cy, hw, hh, fill, stroke, lines):
    a(f'<polygon points="{cx},{cy-hh} {cx+hw},{cy} {cx},{cy+hh} {cx-hw},{cy}" fill="{fill}" stroke="{stroke}" stroke-width="1.5" filter="url(#soft)"/>')
    ny = cy - (len(lines)-1)*8
    for i, ln in enumerate(lines):
        fw = "600" if i == 0 else "400"
        fs = "12.5" if i == 0 else "11"
        a(f'<text x="{cx}" y="{ny+i*15+4}" text-anchor="middle" font-size="{fs}" font-weight="{fw}" fill="{INK}">{ln}</text>')

def vconn(x, y1, y2, marker="arrow-main", col=EKS, label=None, lx=None):
    a(f'<line x1="{x}" y1="{y1}" x2="{x}" y2="{y2}" stroke="{col}" stroke-width="2" marker-end="url(#{marker})"/>')
    # animated flow dot along the connector
    a(f'<circle r="4" fill="{col}">')
    a(f'  <animate attributeName="cx" values="{x};{x}" dur="2.4s" repeatCount="indefinite"/>')
    a(f'  <animate attributeName="cy" values="{y1};{y2-8}" dur="2.4s" repeatCount="indefinite"/>')
    a(f'  <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.15;0.85;1" dur="2.4s" repeatCount="indefinite"/>')
    a('</circle>')
    if label:
        a(f'<rect x="{(lx or x)+6}" y="{(y1+y2)/2-9}" width="{len(label)*6.6+10}" height="18" rx="4" fill="#ffffff" stroke="{RULE}" stroke-width="0.8"/>')
        a(f'<text x="{(lx or x)+11}" y="{(y1+y2)/2+4}" font-size="11" fill="{GRAY}">{label}</text>')

y = 96

# 1. configure
box(CX-160, y, 320, 74, "#fff7ed", EKS, "npm run configure", ["multiple-choice wizard", "&#8594; config/deployment.json"])
b1 = y+74
y = b1 + 34
vconn(CX, b1, y)

# 2. preflight
box(CX-190, y, 380, 96, "#f0fdfa", BEDROCK,
    "preflight.sh  (fail-fast)",
    ["creds &#183; account-not-prod &#183; region &#183; bootstrap",
     "Bedrock model ACTIVE &#183; service quota checks"])
pf_top = y
pf_bot = y + 96
# preflight decision
y = pf_bot + 40
dcx, dcy = CX, y + 44
diamond(dcx, dcy, 120, 52, "#faf5ff", NET, ["preflight", "all checks pass?"])
vconn(CX, pf_bot, y)
# FAIL branch (to the right -> abort)
fail_x = dcx + 120
a(f'<line x1="{fail_x}" y1="{dcy}" x2="{fail_x+120}" y2="{dcy}" stroke="{XACC}" stroke-width="2" marker-end="url(#arrow-fail)"/>')
a(f'<rect x="{fail_x+30}" y="{dcy-38}" width="46" height="16" rx="4" fill="#ffffff" stroke="{RULE}" stroke-width="0.8"/>')
a(f'<text x="{fail_x+53}" y="{dcy-26}" text-anchor="middle" font-size="11" fill="{XACC}">no</text>')
box(fail_x+120, dcy-32, 170, 64, "#fef2f2", XACC, "ABORT deploy", ["exit non-zero", "no partial stacks"], tcol=XACC, tsize=14)

dbot = dcy + 52
y = dbot + 34
vconn(CX, dbot, y, label="yes", lx=CX)

# 3. cdk deploy --all header box
cdk_top = y
a(f'<rect x="{CX-230}" y="{y}" width="460" height="322" rx="10" ry="10" fill="none" stroke="{EKS}" stroke-width="1.6" stroke-dasharray="7,4"/>')
a(f'<rect x="{CX-230}" y="{y}" width="185" height="26" rx="6" fill="{EKS}"/>')
a(f'<text x="{CX-137}" y="{y+18}" text-anchor="middle" class="lbl mono" font-size="13" fill="#ffffff">cdk deploy --all</text>')
a(f'<text x="{CX+150}" y="{y+18}" text-anchor="middle" class="sub" font-size="10.5" fill="{EKS}">ordered by dependency</text>')

# stacks inside
sw = 400
sx = CX - sw/2
sy = y + 40
stacks = [
    ("1  Network", ["VPC &#183; subnets &#183; Bedrock VPCE", "0.0.0.0/0 rejected at 4 layers"], NET, "#faf5ff"),
    ("2  Iam", ["AssumeRole + TagSession (L4)", "least-privilege roles"], XACC, "#fef2f2"),
    ("3  Data (Aurora)", ["Aurora PostgreSQL Serverless v2"], DB, "#eff6ff"),
    ("4  Cluster (EKS 1.31)", ["Pod Identity &#183; CloudWatch &#183; ALB Controller", "LiteLLM v1.88.1  (2 replicas)"], EKS, "#fff7ed"),
    ("5  Gateway", ["Ingress (ALB idle timeout 600s)", "WAF &#183; internal by default"], BEDROCK, "#f0fdfa"),
]
sh = 48
gap = 8
for i, (t, subs, col, fill) in enumerate(stacks):
    yy = sy + i*(sh+gap)
    a(f'<rect x="{sx}" y="{yy}" width="{sw}" height="{sh}" rx="6" fill="{fill}" stroke="{col}" stroke-width="1.4"/>')
    a(f'<rect x="{sx}" y="{yy}" width="5" height="{sh}" rx="2" fill="{col}"/>')
    a(f'<text x="{sx+16}" y="{yy+19}" class="lbl" font-size="13" fill="{INK}">{t}</text>')
    subx = sx+16
    suby = yy+34
    for s in subs:
        a(f'<text x="{subx}" y="{suby}" class="sub" font-size="10.5" fill="{GRAY}">{s}</text>')
        suby += 13
    # inter-stack small arrow
    if i < len(stacks)-1:
        ax = CX
        a(f'<line x1="{ax}" y1="{yy+sh}" x2="{ax}" y2="{yy+sh+gap}" stroke="{EKS}" stroke-width="1.5" marker-end="url(#arrow-main)"/>')

cdk_bot = y + 322
y = cdk_bot + 34
vconn(CX, cdk_bot, y)

# 4. internet-facing decision
dcx2, dcy2 = CX, y + 46
diamond(dcx2, dcy2, 122, 54, "#faf5ff", NET, ["exposure =", "internet-facing?"])
vconn(CX, cdk_bot, y)
# yes -> require cert
fx2 = dcx2 + 122
a(f'<line x1="{fx2}" y1="{dcy2}" x2="{fx2+120}" y2="{dcy2}" stroke="{NET}" stroke-width="2" marker-end="url(#arrow-gray)"/>')
a(f'<rect x="{fx2+34}" y="{dcy2-38}" width="46" height="16" rx="4" fill="#ffffff" stroke="{RULE}" stroke-width="0.8"/>')
a(f'<text x="{fx2+57}" y="{dcy2-26}" text-anchor="middle" font-size="11" fill="{NET}">yes</text>')
box(fx2+120, dcy2-40, 190, 80, "#faf5ff", NET, "REQUIRE ACM cert", ["no HTTP:80 fallback", "else hard-reject deploy"], tcol=NET, tsize=13)

dbot2 = dcy2 + 54
y = dbot2 + 34
vconn(CX, dbot2, y, label="no (internal)", lx=CX)

# 5. post-deploy
box(CX-190, y, 380, 74, "#eff6ff", DB, "post-deploy: render secret", ["litellm-db secret &#8592; Aurora endpoint/creds", "apply to cluster"])
pd_bot = y + 74
y = pd_bot + 34
vconn(CX, pd_bot, y, marker="arrow-ok", col=BEDROCK)

# 6. verify E2E
box(CX-190, y, 380, 80, "#f0fdfa", BEDROCK, "verify E2E", ["virtual key &#8594; ALB &#8594; WAF &#8594; EKS &#8594; LiteLLM", "&#8594; real Bedrock claude-sonnet-4-6 + spend log"], tcol=BEDROCK)
v_bot = y + 80

# --- bottom band (below verify box) ---
band = v_bot + 44
a(f'<line x1="40" y1="{band-16}" x2="920" y2="{band-16}" stroke="{RULE}" stroke-width="1"/>')

# legend (bottom-left)
ly = band + 8
a(f'<text x="40" y="{ly-6}" class="lbl" font-size="12" fill="{INK}">Legend</text>')
leg = [
    (EKS, "arrow-main", "deploy progression"),
    (BEDROCK, "arrow-ok", "success / data path"),
    (XACC, "arrow-fail", "fail-fast abort / cross-account"),
    (NET, "arrow-gray", "network / security gate"),
]
for i, (col, mk, txt) in enumerate(leg):
    yy = ly + 18 + i*20
    a(f'<line x1="40" y1="{yy}" x2="72" y2="{yy}" stroke="{col}" stroke-width="2" marker-end="url(#{mk})"/>')
    a(f'<text x="80" y="{yy+4}" class="sub" font-size="11.5" fill="{GRAY}">{txt}</text>')

# layer note (bottom-right)
a(f'<rect x="620" y="{band}" width="300" height="82" rx="8" fill="#ffffff" stroke="{RULE}" stroke-width="1"/>')
a(f'<text x="636" y="{band+22}" class="lbl" font-size="11.5" fill="{INK}">Isolation layers provisioned</text>')
notes = ["L1 public global.*   &#183;   L2 same-region VPCE",
         "L3 cross-region us.* (peering)",
         "L4 cross-account AssumeRole + TagSession"]
ny = band+42
for n in notes:
    a(f'<text x="636" y="{ny}" class="sub" font-size="10.5" fill="{GRAY}">{n}</text>')
    ny += 15

a('</svg>')

with open('deploy-flow.svg', 'w') as f:
    f.write('\n'.join(L))
print("wrote deploy-flow.svg", len(L), "lines")
