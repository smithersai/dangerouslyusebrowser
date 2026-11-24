#!/usr/bin/env python3
"""
Renders the 1280x720 @ 30fps H.264 (yuv420p) Dub (DangerouslyUseBrowser) demo video
using REAL PNG screenshots captured from the compiled Dub Chromium 157 fork.

Outputs:
  demos/video/dub-demo.mp4
"""
import json
import math
import os
import subprocess
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageChops

W, H = 1280, 720
FPS = 30
TOTAL_SEC = 54.0
TOTAL_FRAMES = int(TOTAL_SEC * FPS)

BASE_DIR = Path(__file__).resolve().parent
CAPTURES_DIR = BASE_DIR / "captures"
OUT_MP4 = BASE_DIR / "dub-demo.mp4"

# Typography (macOS native system fonts)
FONT_SANS_PATH = "/System/Library/Fonts/Avenir Next.ttc"
FONT_MONO_PATH = "/System/Library/Fonts/Menlo.ttc"

def font_sans(size, weight="regular"):
    idx = {"bold": 0, "demi": 2, "medium": 5, "regular": 7, "heavy": 8}.get(weight, 7)
    return ImageFont.truetype(FONT_SANS_PATH, size, index=idx)

def font_mono(size, bold=False):
    return ImageFont.truetype(FONT_MONO_PATH, size, index=1 if bold else 0)

# Pre-load fonts
F_HERO = font_sans(74, "heavy")
F_HERO_SUB = font_sans(28, "demi")
F_HERO_TAG = font_sans(21, "medium")
F_BADGE = font_sans(13, "bold")
F_BADGE_SM = font_sans(11, "bold")
F_H1 = font_sans(21, "bold")
F_CALLOUT_TITLE = font_sans(13, "bold")
F_CALLOUT_BODY = font_sans(15, "medium")
F_CHROME = font_sans(13, "medium")
F_CHROME_B = font_sans(12, "bold")
F_TERM = font_mono(13, False)
F_TERM_B = font_mono(13, True)
F_TERM_SM = font_mono(12, False)
F_OUTRO_CMD = font_mono(22, True)
F_OUTRO_URL = font_sans(24, "bold")

# Colors
C_BG = (7, 11, 20)
C_PANEL = (13, 20, 36)
C_CHROME = (20, 30, 50)
C_TERM_BG = (9, 14, 26)
C_BORDER = (34, 48, 76)
C_WHITE = (248, 250, 252)
C_SLATE = (148, 163, 184)
C_MUTED = (100, 116, 139)
C_EMERALD = (52, 211, 153)
C_EMERALD_BG = (16, 65, 52)
C_CYAN = (56, 189, 248)
C_CYAN_BG = (15, 52, 78)
C_AMBER = (251, 191, 36)
C_AMBER_BG = (68, 49, 16)
C_RED = (248, 113, 113)
C_RED_BG = (72, 24, 30)
C_PURPLE = (196, 181, 253)
C_PURPLE_BG = (49, 32, 86)

def clamp(x, lo=0.0, hi=1.0):
    return max(lo, min(hi, x))

def ease_out_cubic(t):
    t = clamp(t)
    return 1 - (1 - t) ** 3

def lerp_color(c1, c2, t):
    t = clamp(t)
    return tuple(int(c1[i] + (c2[i] - c1[i]) * t) for i in range(3))

# Pre-render crisp dark gradient background with subtle tech grid
def make_background():
    bg = Image.new("RGB", (W, H), C_BG)
    px = bg.load()
    for y in range(H):
        for x in range(W):
            # Subtle vertical gradient + soft cyan/emerald radial glow at top center
            dx = (x - W * 0.55) / (W * 0.65)
            dy = (y - H * 0.15) / (H * 0.75)
            dist = math.sqrt(dx * dx + dy * dy)
            glow = max(0.0, 1.0 - dist) ** 2.2
            r = int(7 + 6 * (y / H) + 10 * glow)
            g = int(11 + 10 * (y / H) + 28 * glow)
            b = int(20 + 18 * (y / H) + 46 * glow)
            px[x, y] = (min(255, r), min(255, g), min(255, b))
    draw = ImageDraw.Draw(bg)
    grid_col = (18, 28, 46)
    for x in range(0, W, 40):
        draw.line([(x, 0), (x, H)], fill=grid_col, width=1)
    for y in range(0, H, 40):
        draw.line([(0, y), (W, y)], fill=grid_col, width=1)
    return bg

BG_BASE = make_background()

# Load and pre-scale all REAL Dub Chromium 157 screenshots to 708x448 (exact aspect ratio of 780x493!)
VP_W, VP_H = 708, 448

def load_shot(name):
    p = CAPTURES_DIR / name
    img = Image.open(p).convert("RGB")
    return img.resize((VP_W, VP_H), Image.Resampling.LANCZOS)

SHOTS = {
    "uc1_before": load_shot("uc1-before.png"),
    "uc1_after": load_shot("uc1-after.png"),
    "uc2_frozen": load_shot("uc2-tab1-frozen.png"),
    "uc2_steps": [load_shot(f"uc2-tab1-step-{i:02d}.png") for i in range(1, 13)],
    "uc2_expired": load_shot("uc2-tab1-expired.png"),
    "uc3_signed_in": load_shot("uc3-1-signed-in.png"),
    "uc3_submitted": load_shot("uc3-2-submitted.png"),
    "uc3_approved": load_shot("uc3-3-approved.png"),
}

def draw_pill(draw, x, y, text, font, fg, bg, border=None, pad_x=12, pad_y=5, align="left"):
    bbox = draw.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    pw, ph = tw + pad_x * 2, th + pad_y * 2 + 2
    if align == "right":
        x = x - pw
    elif align == "center":
        x = x - pw // 2
    draw.rounded_rectangle([x, y, x + pw, y + ph], radius=ph // 2, fill=bg, outline=border or fg, width=1)
    draw.text((x + pad_x, y + pad_y - bbox[1]), text, font=font, fill=fg)
    return pw, ph

def draw_window_dots(draw, x, y):
    for i, col in enumerate([(239, 68, 68), (245, 158, 11), (34, 197, 94)]):
        cx = x + i * 18
        draw.ellipse([cx, y, cx + 10, y + 10], fill=col)

def draw_progress_bar(draw, t):
    frac = clamp(t / TOTAL_SEC)
    draw.rectangle([0, H - 5, W, H], fill=(15, 23, 42))
    bw = int(W * frac)
    if bw > 0:
        draw.rectangle([0, H - 5, bw, H], fill=C_CYAN)
        if bw > 40:
            draw.rectangle([bw - 40, H - 5, bw, H], fill=C_EMERALD)

def draw_terminal(draw, lines_spec, local_t, title="dub — zsh (chromium-157)"):
    """
    lines_spec: list of dicts:
      - start: float (seconds relative to scene start)
      - type: "cmd" | "out" | "blank"
      - text: str (or list of (text, color) tuples for "out")
      - speed: chars/sec for "cmd" (default 48)
    """
    tx, ty, tw, th = 28, 74, 496, 518
    # Outer window
    draw.rounded_rectangle([tx, ty, tx + tw, ty + th], radius=12, fill=C_TERM_BG, outline=C_BORDER, width=1)
    # Header bar
    draw.rounded_rectangle([tx, ty, tx + tw, ty + 34], radius=12, fill=C_CHROME)
    draw.rectangle([tx, ty + 22, tx + tw, ty + 34], fill=C_CHROME)
    draw.line([(tx, ty + 34), (tx + tw, ty + 34)], fill=C_BORDER, width=1)
    draw_window_dots(draw, tx + 14, ty + 12)
    draw.text((tx + 78, ty + 9), title, font=F_CHROME, fill=C_SLATE)
    draw_pill(draw, tx + tw - 10, ty + 6, "NATIVE N-API", F_BADGE_SM, C_EMERALD, C_EMERALD_BG, pad_x=8, pad_y=3, align="right")

    # Body lines
    y = ty + 48
    max_y = ty + th - 18
    line_h = 20
    cursor_pos = None

    for item in lines_spec:
        if local_t < item["start"]:
            break
        if y > max_y:
            break
        kind = item["type"]
        if kind == "blank":
            y += 9
            continue
        if kind == "cmd":
            full = item["text"]
            speed = item.get("speed", 55.0)
            elapsed = local_t - item["start"]
            nchars = min(len(full), int(elapsed * speed))
            shown = full[:nchars]
            prefix = "$ "
            draw.text((tx + 16, y), prefix, font=F_TERM_B, fill=C_EMERALD)
            cx = tx + 16 + int(draw.textlength(prefix, font=F_TERM_B))
            # Pre-wrap full command by whitespace tokens so words never split mid-word
            tokens = full.split(" ")
            wrapped_lines = []
            cur_line = ""
            max_w_first = (tx + tw - 20) - cx
            max_w_cont = (tx + tw - 20) - (tx + 32)
            for tok in tokens:
                cand = tok if not cur_line else (cur_line + " " + tok)
                limit = max_w_first if len(wrapped_lines) == 0 else max_w_cont
                if cur_line and draw.textlength(cand, font=F_TERM) > limit:
                    wrapped_lines.append(cur_line)
                    cur_line = tok
                else:
                    cur_line = cand
            if cur_line:
                wrapped_lines.append(cur_line)

            remaining = nchars
            for li, wline in enumerate(wrapped_lines):
                if remaining <= 0:
                    break
                if li > 0:
                    y += line_h
                seg = wline[:remaining]
                remaining -= len(wline) + 1  # +1 for the space between wrapped lines
                cur_x = cx if li == 0 else (tx + 32)
                for ch_idx, ch in enumerate(seg):
                    col = C_WHITE
                    if seg[max(0, ch_idx-1):ch_idx+1] == "--" or (ch == "-" and ch_idx + 1 < len(seg) and seg[ch_idx+1] == "-"):
                        col = C_CYAN
                    draw.text((cur_x, y), ch, font=F_TERM, fill=col)
                    cur_x += int(draw.textlength(ch, font=F_TERM))
                if nchars < len(full) and remaining <= 0:
                    cursor_pos = (cur_x + 2, y + 2)
            y += line_h + 2
        elif kind == "out":
            segments = item["text"]
            if isinstance(segments, str):
                segments = [(segments, C_SLATE)]
            cur_x = tx + 16
            for seg_text, seg_col in segments:
                draw.text((cur_x, y), seg_text, font=F_TERM_SM, fill=seg_col)
                cur_x += int(draw.textlength(seg_text, font=F_TERM_SM))
            y += line_h - 1

    # Blinking cursor
    if cursor_pos and int(local_t * 3) % 2 == 0:
        cx, cy = cursor_pos
        draw.rectangle([cx, cy, cx + 8, cy + 14], fill=C_EMERALD)

def draw_browser_frame(img, draw, shot_img, url, status_text, status_fg, status_bg, footer_left, footer_right=None, flash_alpha=0.0):
    bx, by, bw, bh = 544, 74, 708, 518
    # Outer container
    draw.rounded_rectangle([bx - 1, by - 1, bx + bw + 1, by + bh + 1], radius=12, fill=C_PANEL, outline=C_BORDER, width=1)
    # Top chrome bar (38px)
    draw.rounded_rectangle([bx, by, bx + bw, by + 38], radius=12, fill=C_CHROME)
    draw.rectangle([bx, by + 24, bx + bw, by + 38], fill=C_CHROME)
    draw.line([(bx, by + 38), (bx + bw, by + 38)], fill=C_BORDER, width=1)
    draw_window_dots(draw, bx + 14, by + 14)

    # URL pill
    ux, uy, uw, uh = bx + 78, by + 7, 360, 24
    draw.rounded_rectangle([ux, uy, ux + uw, uy + uh], radius=6, fill=(10, 15, 28), outline=(38, 52, 82), width=1)
    draw.text((ux + 10, uy + 4), url, font=F_TERM_SM, fill=C_SLATE)

    # Status badge on right
    draw_pill(draw, bx + bw - 10, by + 7, status_text, F_BADGE_SM, status_fg, status_bg, pad_x=10, pad_y=4, align="right")

    # Paste real Dub Chromium screenshot (708x448)
    if flash_alpha > 0.01:
        white_overlay = Image.new("RGB", (VP_W, VP_H), (52, 211, 153))
        blended = Image.blend(shot_img, white_overlay, flash_alpha * 0.35)
        img.paste(blended, (bx, by + 38))
    else:
        img.paste(shot_img, (bx, by + 38))

    # Footer strip (32px, y=by+486..by+518)
    fy = by + 38 + VP_H
    draw.rectangle([bx, fy, bx + bw, by + bh - 8], fill=(11, 17, 32))
    draw.rounded_rectangle([bx, fy + 8, bx + bw, by + bh], radius=12, fill=(11, 17, 32))
    draw.line([(bx, fy), (bx + bw, fy)], fill=C_BORDER, width=1)
    draw.text((bx + 14, fy + 8), footer_left, font=F_TERM_SM, fill=C_EMERALD)
    if footer_right:
        rw = draw.textlength(footer_right, font=F_TERM_SM)
        draw.text((bx + bw - 14 - rw, fy + 8), footer_right, font=F_TERM_SM, fill=C_CYAN)

def draw_scene_header(draw, step_label, title, tag_text, tag_fg, tag_bg):
    draw_pill(draw, 28, 20, step_label, F_BADGE, C_CYAN, C_CYAN_BG, pad_x=10, pad_y=4)
    draw.text((106, 19), title, font=F_H1, fill=C_WHITE)
    draw_pill(draw, W - 28, 20, tag_text, F_BADGE, tag_fg, tag_bg, pad_x=12, pad_y=4, align="right")

def draw_callout_bar(draw, pw_text, dub_text):
    y0, y1 = 606, 694
    # Left: Playwright
    draw.rounded_rectangle([28, y0, 628, y1], radius=12, fill=(22, 16, 28), outline=(120, 40, 52), width=1)
    # Pill with crisp vector X icon
    px, py = 44, y0 + 12
    draw_pill(draw, px, py, "   PLAYWRIGHT", F_BADGE_SM, C_RED, C_RED_BG, pad_x=10, pad_y=3)
    draw.line([(px + 10, py + 6), (px + 17, py + 13)], fill=C_RED, width=2)
    draw.line([(px + 17, py + 6), (px + 10, py + 13)], fill=C_RED, width=2)
    draw.text((44, y0 + 44), pw_text, font=F_CALLOUT_BODY, fill=(241, 213, 218))

    # Right: Dub
    draw.rounded_rectangle([644, y0, 1252, y1], radius=12, fill=(11, 28, 34), outline=(28, 118, 92), width=1)
    # Pill with crisp vector checkmark icon
    dx, dy = 660, y0 + 12
    draw_pill(draw, dx, dy, "   DUB (CHROMIUM 157 FORK)", F_BADGE_SM, C_EMERALD, C_EMERALD_BG, pad_x=10, pad_y=3)
    draw.line([(dx + 9, dy + 10), (dx + 12, dy + 13), (dx + 18, dy + 6)], fill=C_EMERALD, width=2)
    draw.text((660, y0 + 44), dub_text, font=F_CALLOUT_BODY, fill=(209, 250, 229))

def render_intro(t):
    img = BG_BASE.copy()
    draw = ImageDraw.Draw(img)
    p = ease_out_cubic(t / 0.9)
    fade_out = 1.0 - clamp((t - 3.4) / 0.6)
    alpha = p * fade_out
    dy = int((1.0 - p) * 28)

    # Top badge
    draw_pill(draw, W // 2, 170 + dy, "CHROMIUM 157 FORK  ·  NATIVE N-API  ·  INCUR MCP", F_BADGE, C_EMERALD, C_EMERALD_BG, pad_x=16, pad_y=6, align="center")

    # Hero title
    title = "Dub"
    tb = draw.textbbox((0, 0), title, font=F_HERO)
    tw = tb[2] - tb[0]
    draw.text(((W - tw) // 2, 222 + dy), title, font=F_HERO, fill=C_WHITE)

    sub1 = "DangerouslyUseBrowser"
    s1b = draw.textbbox((0, 0), sub1, font=F_HERO_SUB)
    draw.text(((W - (s1b[2] - s1b[0])) // 2, 316 + dy), sub1, font=F_HERO_SUB, fill=C_CYAN)

    sub2 = "Chromium internals for AI agents."
    s2b = draw.textbbox((0, 0), sub2, font=F_HERO_SUB)
    draw.text(((W - (s2b[2] - s2b[0])) // 2, 370 + dy), sub2, font=F_HERO_SUB, fill=C_WHITE)

    # Punchline pill
    if t > 0.7:
        p2 = ease_out_cubic((t - 0.7) / 0.7)
        dy2 = int((1.0 - p2) * 18)
        draw_pill(draw, W // 2, 444 + dy2, "Three things you can't do with Playwright.", F_HERO_TAG, C_AMBER, C_AMBER_BG, pad_x=24, pad_y=10, align="center")

    # Subtle bottom proof note
    note = "All browser frames captured live from compiled Dub Chromium 157"
    nb = draw.textbbox((0, 0), note, font=F_CHROME)
    draw.text(((W - (nb[2] - nb[0])) // 2, 626), note, font=F_CHROME, fill=C_MUTED)

    if alpha < 0.99:
        img = Image.blend(Image.new("RGB", (W, H), C_BG), img, clamp(alpha))
    draw = ImageDraw.Draw(img)
    draw_progress_bar(draw, t)
    return img

def render_uc1(t, local_t):
    img = BG_BASE.copy()
    draw = ImageDraw.Draw(img)

    draw_scene_header(
        draw, "01 / 03",
        "Hot-patch a prod JS bug behind a Service Worker",
        "NetworkService Hook", C_EMERALD, C_EMERALD_BG
    )

    lines = [
        {"start": 0.4, "type": "out", "text": [("# Prod bug: SW caches viewer role & retries:0", C_MUTED)]},
        {"start": 0.8, "type": "cmd", "text": "dub net rewrite https://billing.acme.io/v1/user --body admin.json", "speed": 62},
        {"start": 2.3, "type": "out", "text": [("→ ", C_EMERALD), ('{"ok":true,"layer":"NetworkService","id":"rw-1"}', C_SLATE)]},
        {"start": 2.8, "type": "blank"},
        {"start": 3.0, "type": "cmd", "text": 'dub net patch "*/static/app.*.js" --replace "retries:0" --with "retries:3"', "speed": 62},
        {"start": 4.6, "type": "out", "text": [("→ ", C_EMERALD), ('{"ok":true,"layer":"NetworkService","id":"pt-1"}', C_SLATE)]},
        {"start": 5.2, "type": "blank"},
        {"start": 5.4, "type": "cmd", "text": "dub net log --follow", "speed": 52},
        {"start": 6.1, "type": "out", "text": [("[SW->NET] ", C_CYAN), ("GET /static/app.4f9a.js  ", C_WHITE), ("PATCHED 200", C_EMERALD)]},
        {"start": 6.7, "type": "out", "text": [("[SW->NET] ", C_CYAN), ("GET /v1/user             ", C_WHITE), ("REWRITTEN 200", C_EMERALD)]},
        {"start": 7.5, "type": "blank"},
        {"start": 7.8, "type": "out", "text": [("✓ ", C_EMERALD), ("role: viewer -> admin (enterprise)", C_EMERALD)]},
        {"start": 8.4, "type": "out", "text": [("✓ ", C_EMERALD), ("APP_CONFIG.retries: 0 -> 3 (live)", C_EMERALD)]},
        {"start": 9.0, "type": "out", "text": [("✓ ", C_EMERALD), ("serviceWorker.controller: active", C_CYAN)]},
    ]
    draw_terminal(draw, lines, local_t)

    # Switch BEFORE -> AFTER at local_t = 5.8s
    switched = local_t >= 5.8
    flash = clamp(1.0 - (local_t - 5.8) / 0.55) if switched else 0.0
    if not switched:
        draw_browser_frame(
            img, draw, SHOTS["uc1_before"],
            "https://billing.acme.io/dashboard",
            "BEFORE · BUG #418", C_AMBER, C_AMBER_BG,
            "● Real Dub Chromium 157 · SW controlled: true · retries: 0",
            "role: viewer",
        )
    else:
        draw_browser_frame(
            img, draw, SHOTS["uc1_after"],
            "https://billing.acme.io/dashboard",
            "AFTER · HOT-PATCHED", C_EMERALD, C_EMERALD_BG,
            "● Real Dub Chromium 157 · SW controlled: true · retries: 3",
            "role: admin",
            flash_alpha=flash,
        )

    draw_callout_bar(
        draw,
        "page.route() misses Service Worker synthetic responses & CacheStorage.",
        "Hooks Chromium's NetworkService directly — live hot-patch, zero redeploy."
    )
    draw_progress_bar(draw, t)
    return img

def render_uc2(t, local_t):
    img = BG_BASE.copy()
    draw = ImageDraw.Draw(img)

    draw_scene_header(
        draw, "02 / 03",
        "Time-travel a 30-day trial + step CSS frames in ONE tab",
        "Per-Tab V8 + Blink Clock", C_CYAN, C_CYAN_BG
    )

    lines = [
        {"start": 0.3, "type": "out", "text": [("# Tab 1: Trial UI  |  Tab 2: Live wall clock", C_MUTED)]},
        {"start": 0.7, "type": "cmd", "text": "dub clock freeze --tab 1 --at 2026-01-01T09:00:00Z", "speed": 62},
        {"start": 1.9, "type": "out", "text": [("→ ", C_EMERALD), ('{"tab":1,"frozen":true,"at":"2026-01-01T09:00:00Z"}', C_SLATE)]},
        {"start": 2.6, "type": "blank"},
        {"start": 3.2, "type": "cmd", "text": "dub clock step --tab 1 --frames 1   # x60 deterministic", "speed": 62},
        {"start": 4.4, "type": "out", "text": [("→ ", C_CYAN), ('rAF stepped: 67.5px -> 325.0px -> 634.0px', C_SLATE)]},
        {"start": 5.6, "type": "out", "text": [("→ ", C_CYAN), ('Blink CSS @keyframes advancing frame-by-frame', C_SLATE)]},
        {"start": 10.6, "type": "blank"},
        {"start": 10.8, "type": "cmd", "text": "dub clock advance --tab 1 --by 31d", "speed": 58},
        {"start": 12.1, "type": "out", "text": [("→ ", C_EMERALD), ('{"tab":1,"now":"2026-02-01T09:00:01Z"}', C_SLATE)]},
        {"start": 12.8, "type": "out", "text": [("✓ ", C_EMERALD), ("Day 30 setInterval fired -> Modal OPEN", C_AMBER)]},
        {"start": 13.5, "type": "out", "text": [("✓ ", C_EMERALD), ("Tab 2 wall clock untouched (2026-11-24)", C_CYAN)]},
    ]
    draw_terminal(draw, lines, local_t)

    # Live ticking Tab 2 wall clock (based on real capture 18:53:25.100 -> 18:53:42.xxx)
    base_sec = 25.100 + local_t
    sec_whole = int(base_sec)
    ms = int((base_sec - sec_whole) * 1000)
    tab2_clock = f"TAB 2 (LIVE): 2026-11-24 18:53:{sec_whole:02d}.{ms:03d} UTC"

    # Choose real Dub Chromium screenshot for Tab 1:
    # 0.0..3.8s: frozen
    # 3.8..10.4s: 12 real stepped screenshots (0.55s each)
    # 10.4..12.1s: hold step 12
    # 12.1..17.5s: expired modal
    if local_t < 3.8:
        shot = SHOTS["uc2_frozen"]
        st_txt, st_fg, st_bg = "TAB 1 · FROZEN", C_CYAN, C_CYAN_BG
        flash = 0.0
    elif local_t < 12.1:
        idx = min(11, int((local_t - 3.8) / 0.55))
        shot = SHOTS["uc2_steps"][idx]
        st_txt, st_fg, st_bg = f"STEPPING · {(idx + 1) * 5}/60 FRAMES", C_CYAN, C_CYAN_BG
        flash = 0.0
    else:
        shot = SHOTS["uc2_expired"]
        st_txt, st_fg, st_bg = "TAB 1 · +31 DAYS (EXPIRED)", C_RED, C_RED_BG
        flash = clamp(1.0 - (local_t - 12.1) / 0.45)

    draw_browser_frame(
        img, draw, shot,
        "https://app.acme.io/billing/trial  [Tab 1]",
        st_txt, st_fg, st_bg,
        "● Real Dub Chromium 157 · Per-tab clock",
        tab2_clock,
        flash_alpha=flash,
    )

    draw_callout_bar(
        draw,
        "Monkey-patches JS globals & misses CSS animations / shared clocks.",
        "Isolates V8 + Blink animation clocks per tab — live tabs keep ticking."
    )
    draw_progress_bar(draw, t)
    return img

def render_uc3(t, local_t):
    img = BG_BASE.copy()
    draw = ImageDraw.Draw(img)

    draw_scene_header(
        draw, "03 / 03",
        "Act as you: Signed-in session + Native Actor + WebMCP",
        "Persistent Profile · isTrusted", C_PURPLE, C_PURPLE_BG
    )

    lines = [
        {"start": 0.3, "type": "cmd", "text": "dub profile attach --name Default", "speed": 62},
        {"start": 1.2, "type": "out", "text": [("→ ", C_EMERALD), ('{"attached":true,"user":"will@acme.io"}', C_SLATE)]},
        {"start": 1.8, "type": "blank"},
        {"start": 2.0, "type": "cmd", "text": "dub tools list --tab 1", "speed": 62},
        {"start": 2.8, "type": "out", "text": [("→ ", C_PURPLE), ("page.submit_expense  ", C_WHITE), ("(WebMCP)", C_PURPLE)]},
        {"start": 3.2, "type": "out", "text": [("→ ", C_CYAN), ("actor.click, actor.type, ... (8 native)", C_SLATE)]},
        {"start": 3.9, "type": "blank"},
        {"start": 4.1, "type": "cmd", "text": 'dub tools call page.submit_expense \'{"amount":42.10,"memo":"Team lunch"}\'', "speed": 64},
        {"start": 5.7, "type": "out", "text": [("→ ", C_EMERALD), ('{"submitted":true,"id":"EXP-4091"}', C_SLATE)]},
        {"start": 6.4, "type": "blank"},
        {"start": 7.6, "type": "cmd", "text": 'dub tools call actor.click \'{"target":"#approve-btn"}\'', "speed": 62},
        {"start": 9.0, "type": "out", "text": [("→ ", C_EMERALD), ('{"clicked":true,"isTrusted":true,"cdp":false}', C_EMERALD)]},
        {"start": 9.8, "type": "out", "text": [("✓ ", C_EMERALD), ("Zero selectors for WebMCP · Zero CDP leak", C_CYAN)]},
    ]
    draw_terminal(draw, lines, local_t)

    if local_t < 5.7:
        shot = SHOTS["uc3_signed_in"]
        st_txt, st_fg, st_bg = "SIGNED IN · PERSISTED", C_CYAN, C_CYAN_BG
        footer_r = "9 tools discovered"
        flash = 0.0
    elif local_t < 9.0:
        shot = SHOTS["uc3_submitted"]
        st_txt, st_fg, st_bg = "WEBMCP · SUBMITTED", C_PURPLE, C_PURPLE_BG
        footer_r = "EXP-4091 ($42.10)"
        flash = clamp(1.0 - (local_t - 5.7) / 0.4)
    else:
        shot = SHOTS["uc3_approved"]
        st_txt, st_fg, st_bg = "APPROVED · isTrusted=true", C_EMERALD, C_EMERALD_BG
        footer_r = "CDP: false"
        flash = clamp(1.0 - (local_t - 9.0) / 0.45)

    draw_browser_frame(
        img, draw, shot,
        "https://expenses.acme.io/approvals",
        st_txt, st_fg, st_bg,
        "● Real Dub Chromium 157 · Native Actor + WebMCP",
        footer_r,
        flash_alpha=flash,
    )

    draw_callout_bar(
        draw,
        "Brittle CSS selectors & detectable CDP Runtime.enable fingerprint.",
        "Native Chromium Actor (isTrusted: true) + WebMCP on your real profile."
    )
    draw_progress_bar(draw, t)
    return img

def render_outro(t, local_t):
    img = BG_BASE.copy()
    draw = ImageDraw.Draw(img)
    p = ease_out_cubic(local_t / 0.7)
    dy = int((1.0 - p) * 20)

    draw_pill(draw, W // 2, 136 + dy, "OPEN SOURCE  ·  MIT LICENSE  ·  CHROMIUM 157", F_BADGE, C_EMERALD, C_EMERALD_BG, pad_x=16, pad_y=6, align="center")

    title = "Dub"
    tb = draw.textbbox((0, 0), title, font=F_HERO)
    draw.text(((W - (tb[2] - tb[0])) // 2, 186 + dy), title, font=F_HERO, fill=C_WHITE)

    sub = "Chromium internals for AI agents."
    sb = draw.textbbox((0, 0), sub, font=F_HERO_SUB)
    draw.text(((W - (sb[2] - sb[0])) // 2, 282 + dy), sub, font=F_HERO_SUB, fill=C_SLATE)

    # Command box
    bx, by, bw, bh = 310, 352 + dy, 660, 124
    draw.rounded_rectangle([bx, by, bx + bw, by + bh], radius=14, fill=C_TERM_BG, outline=C_BORDER, width=2)
    draw.text((bx + 32, by + 26), "$", font=F_OUTRO_CMD, fill=C_EMERALD)
    draw.text((bx + 58, by + 26), "npm i -g dangerouslyusebrowser", font=F_OUTRO_CMD, fill=C_WHITE)
    draw.text((bx + 32, by + 70), "$", font=F_OUTRO_CMD, fill=C_EMERALD)
    draw.text((bx + 58, by + 70), "dub serve --port 7777", font=F_OUTRO_CMD, fill=C_CYAN)

    # URL pill
    draw_pill(draw, W // 2, 520 + dy, "dangerouslyusebrowser.smithers.sh", F_OUTRO_URL, C_WHITE, (18, 42, 74), border=C_CYAN, pad_x=28, pad_y=12, align="center")

    if p < 0.99:
        img = Image.blend(Image.new("RGB", (W, H), C_BG), img, clamp(p))
    draw = ImageDraw.Draw(img)
    draw_progress_bar(draw, t)
    return img

def render_frame(frame_idx):
    t = frame_idx / FPS
    if t < 4.0:
        return render_intro(t)
    elif t < 19.0:
        img = render_uc1(t, t - 4.0)
        if t < 4.35:
            img = Image.blend(Image.new("RGB", (W, H), C_BG), img, clamp((t - 4.0) / 0.35))
        elif t > 18.65:
            img = Image.blend(Image.new("RGB", (W, H), C_BG), img, clamp((19.0 - t) / 0.35))
        return img
    elif t < 36.5:
        img = render_uc2(t, t - 19.0)
        if t < 19.35:
            img = Image.blend(Image.new("RGB", (W, H), C_BG), img, clamp((t - 19.0) / 0.35))
        elif t > 36.15:
            img = Image.blend(Image.new("RGB", (W, H), C_BG), img, clamp((36.5 - t) / 0.35))
        return img
    elif t < 50.0:
        img = render_uc3(t, t - 36.5)
        if t < 36.85:
            img = Image.blend(Image.new("RGB", (W, H), C_BG), img, clamp((t - 36.5) / 0.35))
        elif t > 49.65:
            img = Image.blend(Image.new("RGB", (W, H), C_BG), img, clamp((50.0 - t) / 0.35))
        return img
    else:
        return render_outro(t, t - 50.0)

def main():
    cmd = [
        "ffmpeg", "-y",
        "-f", "rawvideo",
        "-vcodec", "rawvideo",
        "-pix_fmt", "rgb24",
        "-s", f"{W}x{H}",
        "-r", str(FPS),
        "-i", "-",
        "-c:v", "libx264",
        "-preset", "medium",
        "-crf", "18",
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        str(OUT_MP4),
    ]
    print(f"Rendering {TOTAL_FRAMES} frames ({TOTAL_SEC:.1f}s @ {FPS}fps, {W}x{H}) -> {OUT_MP4}")
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    assert proc.stdin is not None
    try:
        for i in range(TOTAL_FRAMES):
            frame = render_frame(i)
            proc.stdin.write(frame.tobytes())
            if (i + 1) % 300 == 0 or i + 1 == TOTAL_FRAMES:
                print(f"  rendered {i + 1}/{TOTAL_FRAMES} frames ({(i + 1) / TOTAL_FRAMES * 100:.0f}%)", flush=True)
    finally:
        proc.stdin.close()
    rc = proc.wait()
    if rc != 0:
        sys.exit(rc)
    size_mb = OUT_MP4.stat().st_size / (1024 * 1024)
    print(f"Done! {OUT_MP4} ({size_mb:.2f} MB)")

if __name__ == "__main__":
    main()
