#!/usr/bin/env python3
"""Two small test collections for launch rehearsals — Solana Waves and
Robinhood Waves — plus a PFP and banner for each.

Pixel art drawn on a 24x24 grid and upscaled with nearest-neighbour, so the
output is crisp at any size and matches what the editor produces. The motif is
the brand: a horizon, layered waves, the WAVES staircase climbing out of them,
and a sun that sets in the chain's own gradient.

    python3 tools/make-test-collections.py [outdir]

Writes <outdir>/<chain>/{1..N}.png, pfp.png, banner.png.
"""
import os, sys, json, random
from PIL import Image, ImageDraw

G = 24                      # pixel grid
PIECE = 1024                # exported piece size
N = 10                      # pieces per collection

CHAINS = {
    "solana": {
        "name": "Solana Waves",
        "symbol": "SWAVE",
        "desc": "A test collection for WAVES on Solana. Pixel seascapes with the staircase climbing out of the water.",
        "bg":   ["#0a0a12", "#12081f", "#0d0a18", "#160a24"],
        "sky":  ["#2b1a4d", "#3a1f63", "#241546"],
        "a":    "#9945FF",   # gradient start
        "b":    "#14F195",   # gradient end
        "sun":  ["#14F195", "#5cffb9", "#b06bff"],
    },
    "robinhood": {
        "name": "Robinhood Waves",
        "symbol": "RWAVE",
        "desc": "A test collection for WAVES on Robinhood Chain. Pixel seascapes with the staircase climbing out of the water.",
        "bg":   ["#0a0a0a", "#0d0f08", "#0b0d06", "#101208"],
        "sky":  ["#2f3a12", "#3d4a18", "#25300e"],
        "a":    "#CCFF00",
        "b":    "#d9d9d9",
        "sun":  ["#f2f2f2", "#d9d9d9", "#ffffff"],
    },
}


def hx(c):
    """Accepts "#rrggbb" or an already-resolved (r,g,b), so mixed colours can
    be mixed again without the caller tracking which form it holds."""
    if isinstance(c, (tuple, list)):
        return tuple(c)
    c = c.lstrip("#")
    return tuple(int(c[i:i + 2], 16) for i in (0, 2, 4))


def mix(c1, c2, t):
    a, b = hx(c1), hx(c2)
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


# names for the choices, so the metadata reads like a real collection
SKY_N = ["Deep Night", "Twilight", "Dusk", "Midnight"]
TIDE_N = {3: "Calm", 4: "Rolling", 5: "Heavy Swell"}
SUN_N = ["High Sun", "Setting", "Half Sunk", "None"]
STAIR_N = {2: "Small Steps", 3: "Tall Steps", 0: "None"}


def draw_piece(pal, rnd):
    """One 24x24 piece, and the traits that made it. Returns (image, attrs) so
    the metadata describes what was actually drawn rather than a guess."""
    attrs = []
    bgi = rnd.randrange(len(pal["bg"]))
    im = Image.new("RGB", (G, G), hx(pal["bg"][bgi]))
    d = ImageDraw.Draw(im)
    attrs.append(("Sky", SKY_N[bgi % len(SKY_N)]))

    horizon = rnd.choice([13, 14, 15])
    attrs.append(("Horizon", {13: "High", 14: "Even", 15: "Low"}[horizon]))

    # sky band, darker at the top
    sky = rnd.choice(pal["sky"])
    for y in range(horizon):
        t = y / max(1, horizon - 1)
        d.line([(0, y), (G - 1, y)], fill=mix("#000000", sky, 0.25 + 0.75 * t))

    # sun: an orb sitting on or just above the horizon
    if rnd.random() < 0.85:
        sr = rnd.choice([2, 3, 3, 4])
        sx = rnd.randint(sr + 1, G - sr - 2)
        sunk = rnd.choice([0, 1, 2])
        sy = horizon - sunk
        attrs.append(("Sun", SUN_N[2 - sunk]))
        col = hx(rnd.choice(pal["sun"]))
        d.ellipse([sx - sr, sy - sr, sx + sr, sy + sr], fill=col)
        # a couple of scan lines through it, like a sunset stripe
        for yy in range(sy - sr, sy + sr + 1, 2):
            d.line([(sx - sr, yy), (sx + sr, yy)], fill=mix("#000000", "#ffffff", .05))

    else:
        attrs.append(("Sun", "None"))

    # waves: stacked bands running the chain's gradient as they recede
    bands = rnd.choice([3, 4, 4, 5])
    attrs.append(("Tide", TIDE_N[bands]))
    for i in range(bands):
        t = i / max(1, bands - 1)
        col = mix(pal["a"], pal["b"], t)
        y = horizon + 1 + int(i * (G - horizon - 1) / bands)
        amp = rnd.choice([0, 1, 1, 2])
        phase = rnd.random() * 6.28
        for x in range(G):
            import math
            off = int(round(amp * math.sin(phase + x / 3.0)))
            yy = min(G - 1, y + off)
            if yy - 1 >= horizon:
                d.point((x, yy - 1), fill=mix("#000000", col, .22))
            d.line([(x, yy), (x, min(G - 1, yy + 1))], fill=col)

    # the staircase, climbing out of the water
    if rnd.random() < 0.9:
        s = rnd.choice([2, 3])
        attrs.append(("Staircase", STAIR_N[s]))
        bx = rnd.randint(1, G - 3 * s - 1)
        by = horizon - rnd.choice([2, 3, 4])
        for k in range(3):
            col = mix(pal["a"], pal["b"], k / 2)
            x0, y0 = bx + k * s, by - k * s
            d.rectangle([x0, y0, x0 + s - 1, y0 + s - 1], fill=col)

    else:
        attrs.append(("Staircase", "None"))

    # sparkles
    stars = rnd.choice([0, 2, 3, 5])
    attrs.append(("Stars", {0: "Clear", 2: "Few", 3: "Scattered", 5: "Many"}[stars]))
    for _ in range(stars):
        x, y = rnd.randint(0, G - 1), rnd.randint(0, horizon - 1)
        d.point((x, y), fill=mix("#ffffff", pal["b"], rnd.random()))

    return im, attrs


def banner(pal, rnd):
    """1500x500, drawn on a 60x20 grid so the pixels stay square."""
    BW, BH = 60, 20
    im = Image.new("RGB", (BW, BH), hx(pal["bg"][0]))
    d = ImageDraw.Draw(im)
    horizon = 11
    sky = pal["sky"][0]
    for y in range(horizon):
        d.line([(0, y), (BW - 1, y)], fill=mix("#000000", sky, .25 + .75 * y / horizon))
    # big sun, right of centre
    sr, sx, sy = 4, 41, horizon - 1
    d.ellipse([sx - sr, sy - sr, sx + sr, sy + sr], fill=hx(pal["sun"][0]))
    # waves
    import math
    for i in range(5):
        t = i / 4
        col = mix(pal["a"], pal["b"], t)
        y = horizon + 1 + int(i * (BH - horizon - 1) / 5)
        for x in range(BW):
            off = int(round(1.5 * math.sin(x / 4.0 + i)))
            yy = min(BH - 1, y + off)
            if yy - 1 >= horizon:
                d.point((x, yy - 1), fill=mix("#000000", col, .22))
            d.line([(x, yy), (x, min(BH - 1, yy + 1))], fill=col)
    # staircase, left third, clear of where a PFP would sit
    s, bx, by = 2, 14, horizon - 2
    for k in range(3):
        col = mix(pal["a"], pal["b"], k / 2)
        x0, y0 = bx + k * s, by - k * s
        d.rectangle([x0, y0, x0 + s - 1, y0 + s - 1], fill=col)
    for _ in range(30):
        x, y = rnd.randint(0, BW - 1), rnd.randint(0, horizon - 2)
        d.point((x, y), fill=mix("#ffffff", pal["b"], rnd.random()))
    return im.resize((1500, 500), Image.NEAREST)


def pfp(pal):
    """The staircase on the chain's gradient, centred — survives a circle crop."""
    im = Image.new("RGB", (G, G), hx(pal["bg"][0]))
    d = ImageDraw.Draw(im)
    for y in range(G):
        d.line([(0, y), (G - 1, y)], fill=mix(pal["bg"][0], pal["sky"][0], y / G * .8))
    s = 5
    bx, by = 3, 16
    for k in range(3):
        col = mix(pal["a"], pal["b"], k / 2)
        x0, y0 = bx + k * s, by - k * s
        d.rectangle([x0, y0, x0 + s - 1, y0 + s - 1], fill=col)
    return im.resize((1024, 1024), Image.NEAREST)


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/Desktop/waves-test")
    for key, pal in CHAINS.items():
        d = os.path.join(out, key)
        os.makedirs(d, exist_ok=True)
        rnd = random.Random(sum(ord(ch) * (i + 7) for i, ch in enumerate(key)))
        for i in range(1, N + 1):
            im, attrs = draw_piece(pal, rnd)
            im.resize((PIECE, PIECE), Image.NEAREST).save(os.path.join(d, "%d.png" % i))
            # the launch page pairs <n>.json with <n>.png and keeps our name and
            # attributes; without it every piece would just be "#n" with no traits
            meta = {
                "name": "%s #%d" % (pal["name"], i),
                "symbol": pal["symbol"],
                "description": pal["desc"],
                "attributes": [{"trait_type": k, "value": v} for k, v in attrs],
            }
            with open(os.path.join(d, "%d.json" % i), "w") as f:
                json.dump(meta, f, indent=2)
        pfp(pal).save(os.path.join(d, "pfp.png"))
        banner(pal, rnd).save(os.path.join(d, "banner.png"))
        print("%-10s %s  (%d pieces + pfp + banner)" % (pal["name"], d, N))


if __name__ == "__main__":
    main()
