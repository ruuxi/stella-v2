#!/usr/bin/env python3
"""Generate Stella's CarPlay glyph assets.

CarPlay only lets us ship Apple's templates, so the brand has to live in copy,
the Stella wordmark/logo, and the few tintable icon slots (now-playing button,
voice-control state, list leading icon). These glyphs carry Stella's green
accent (the palette's `ok`/success green) into those slots.

Rendered at 3x master resolution and downsampled for crisp anti-aliasing, then
written at @1x/@2x/@3x so Metro/Expo can pick the right density automatically.

Run:  python3 assets/carplay/generate-icons.py
"""

from PIL import Image, ImageDraw

STELLA_GREEN = (52, 199, 89, 255)

BASE = 88
SS = 4

def _canvas():
    return Image.new("RGBA", (BASE * SS, BASE * SS), (0, 0, 0, 0))

def _finish(img, name):
    for scale, suffix in ((1, ""), (2, "@2x"), (3, "@3x")):
        out = img.resize((BASE * scale, BASE * scale), Image.LANCZOS)
        out.save(f"{name}{suffix}.png")
    print(f"wrote {name}.png (+@2x/@3x)")

def mic():
    """Microphone — the tap-to-talk affordance."""
    img = _canvas()
    d = ImageDraw.Draw(img)
    s = SS
    cx = BASE * s / 2

    bw, bh = 26 * s, 44 * s
    top = 14 * s
    d.rounded_rectangle(
        [cx - bw / 2, top, cx + bw / 2, top + bh],
        radius=bw / 2,
        fill=STELLA_GREEN,
    )

    arc_w = 46 * s
    arc_top = 30 * s
    arc_bottom = 30 * s + 40 * s
    d.arc(
        [cx - arc_w / 2, arc_top, cx + arc_w / 2, arc_bottom],
        start=20,
        end=160,
        fill=STELLA_GREEN,
        width=6 * s,
    )

    stem_top = arc_bottom - 6 * s
    d.line([cx, stem_top, cx, stem_top + 12 * s], fill=STELLA_GREEN, width=6 * s)
    d.line(
        [cx - 14 * s, stem_top + 12 * s, cx + 14 * s, stem_top + 12 * s],
        fill=STELLA_GREEN,
        width=6 * s,
    )
    _finish(img, "stella-voice-mic")

def replay():
    """Circular arrow — replay the last spoken reply."""
    img = _canvas()
    d = ImageDraw.Draw(img)
    s = SS
    cx = cy = BASE * s / 2
    r = 28 * s
    d.arc(
        [cx - r, cy - r, cx + r, cy + r],
        start=70,
        end=400,
        fill=STELLA_GREEN,
        width=7 * s,
    )

    import math

    ang = math.radians(70)
    ax = cx + r * math.cos(ang)
    ay = cy + r * math.sin(ang)
    head = 11 * s
    d.polygon(
        [
            (ax, ay - head),
            (ax + head, ay + head * 0.2),
            (ax - head * 0.6, ay + head * 0.9),
        ],
        fill=STELLA_GREEN,
    )
    _finish(img, "stella-voice-replay")

def listening():
    """Concentric pulse — the live listening / thinking state."""
    img = _canvas()
    d = ImageDraw.Draw(img)
    s = SS
    cx = cy = BASE * s / 2

    core = 9 * s
    d.ellipse([cx - core, cy - core, cx + core, cy + core], fill=STELLA_GREEN)

    for r, alpha in ((20 * s, 200), (31 * s, 110)):
        d.ellipse(
            [cx - r, cy - r, cx + r, cy + r],
            outline=STELLA_GREEN[:3] + (alpha,),
            width=5 * s,
        )
    _finish(img, "stella-voice-listening")

if __name__ == "__main__":
    import os

    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    mic()
    replay()
    listening()
