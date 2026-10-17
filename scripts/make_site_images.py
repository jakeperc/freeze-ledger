#!/usr/bin/env python3
"""Draw the site's share card and icons into site/static/.

The card is the timeline field as the page draws it: one point per public
freeze, release or destroyed balance, left to right in time, one lane per
chain and token, coloured by chain. It carries no counts, so it does not go
stale between runs; re-run it when the picture should catch up.

Fonts are IBM Plex from the site's node_modules. They ship as WOFF, which
Pillow cannot read, so each is unpacked to a plain TrueType file first (WOFF
1.0 is the same tables, each zlib-compressed).

Usage: python scripts/make_site_images.py   (needs Pillow and site/node_modules)
"""

from __future__ import annotations

import json
import math
import struct
import tempfile
import zlib
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "site" / "static"
FONTS = ROOT / "site" / "node_modules" / "@fontsource"

INK = (13, 13, 26)
PAPER = (236, 236, 243)
PAPER_2 = (169, 169, 196)
PAPER_3 = (125, 125, 160)
RULE = (38, 38, 67)
FROST = (169, 214, 255)
CHAIN = {"ethereum": (142, 162, 255), "base": (79, 140, 255), "tron": (255, 107, 107), "solana": (142, 227, 200)}
LANES = [("ethereum", "USDT"), ("ethereum", "USDC"), ("base", "USDC"), ("tron", "USDT"), ("solana", "USDC"), ("solana", "USDT")]


def woff_to_ttf(src: Path, dst: Path) -> Path:
    """Unpack a WOFF 1.0 file into the sfnt it wraps."""
    data = src.read_bytes()
    sig, flavor, _length, num_tables = struct.unpack(">4sIIH", data[:14])
    if sig != b"wOFF":
        raise ValueError(f"{src.name} is not WOFF 1.0")
    entries = [struct.unpack(">4sIIII", data[44 + 20 * i : 64 + 20 * i]) for i in range(num_tables)]
    search = 2 ** int(math.log2(num_tables))
    header = struct.pack(">IHHHH", flavor, num_tables, search * 16, int(math.log2(search)), num_tables * 16 - search * 16)
    offset = 12 + 16 * num_tables
    directory, bodies = b"", b""
    for tag, off, comp_len, orig_len, checksum in entries:
        raw = data[off : off + comp_len]
        table = zlib.decompress(raw) if comp_len < orig_len else raw
        directory += struct.pack(">4sIII", tag, checksum, offset + len(bodies), orig_len)
        bodies += table + b"\0" * (-len(table) % 4)
    dst.write_bytes(header + directory + bodies)
    return dst


def font(tmp: Path, family: str, file: str, size: int) -> ImageFont.FreeTypeFont:
    ttf = tmp / (file + ".ttf")
    if not ttf.exists():
        woff_to_ttf(FONTS / family / "files" / (file + ".woff"), ttf)
    return ImageFont.truetype(str(ttf), size)


def hash01(i: int, salt: int) -> float:
    """The page's per-point jitter (lib/layouts.ts), so the card matches the field."""
    x = ((i + 1) * 374761393 + salt * 668265263) & 0xFFFFFFFF
    x = ((x ^ (x >> 13)) * 1274126177) & 0xFFFFFFFF
    x = x ^ (x >> 16)
    return (x % 100000) / 100000


def field(draw: ImageDraw.ImageDraw, site: dict, box: tuple[int, int, int, int], r: float) -> None:
    """Timeline lanes, heights by the square root of their events, as on the page."""
    x0, y0, x1, y1 = box
    n = site["n"]
    lane_of = []
    for i in range(n):
        key = (site["chains"][site["c"][i]], site["tokens"][site["k"][i]])
        lane_of.append(LANES.index(key) if key in LANES else -1)
    counts = [lane_of.count(li) for li in range(len(LANES))]
    most = max(1, *counts)
    weights = [0.45 + 0.55 * math.sqrt(c / most) if c else 0.22 for c in counts]
    total = sum(weights)
    tops, heights, cursor = [], [], y0
    for w in weights:
        h = (y1 - y0) * w / total
        tops.append(cursor)
        heights.append(h)
        cursor += h
    for t in tops[1:]:
        draw.line([(x0, t), (x1, t)], fill=RULE, width=1)
    t_min, t_max = site["t"][0], site["t"][n - 1]
    for i in range(n):
        li = lane_of[i]
        if site["internal"][i] or li < 0:
            continue
        x = x0 + (site["t"][i] - t_min) / max(1, t_max - t_min) * (x1 - x0)
        y = tops[li] + heights[li] / 2 + (hash01(i, 1) - 0.5) * heights[li] * 0.72
        draw.ellipse([x - r, y - r, x + r, y + r], fill=CHAIN[site["chains"][site["c"][i]]])


def share_card(site: dict, tmp: Path) -> None:
    W, H, S = 1200, 630, 2  # drawn at 2x, then scaled down for smooth points
    img = Image.new("RGB", (W * S, H * S), INK)
    d = ImageDraw.Draw(img)
    title = font(tmp, "ibm-plex-sans-condensed", "ibm-plex-sans-condensed-latin-600-normal", 92 * S)
    sans = font(tmp, "ibm-plex-sans", "ibm-plex-sans-latin-400-normal", 30 * S)
    mono = font(tmp, "ibm-plex-mono", "ibm-plex-mono-latin-400-normal", 20 * S)
    pad = 64 * S
    d.text((pad, 52 * S), "Freeze Ledger", font=title, fill=PAPER)
    d.text((pad, 160 * S), "Every stablecoin issuer freeze, with its receipt", font=sans, fill=PAPER_2)
    d.text((pad, 204 * S), "USDT and USDC on Ethereum, Base, Tron and Solana", font=mono, fill=PAPER_3)
    field(d, site, (pad, 268 * S, W * S - pad, H * S - 56 * S), r=2.2 * S)
    img.resize((W, H), Image.LANCZOS).save(OUT / "og.png", optimize=True)


def icon(size: int, name: str, rounded: bool) -> None:
    """The favicon's mark: a frost point on ink. iOS rounds its own corners."""
    S = 4
    img = Image.new("RGBA", (size * S, size * S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if rounded:
        d.rounded_rectangle([0, 0, size * S - 1, size * S - 1], radius=size * S * 6 // 32, fill=INK)
    else:
        d.rectangle([0, 0, size * S, size * S], fill=INK)
    c, r = size * S / 2, size * S * 6 / 32
    d.ellipse([c - r, c - r, c + r, c + r], fill=FROST)
    img.resize((size, size), Image.LANCZOS).save(OUT / name, optimize=True)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    site = json.loads((ROOT / "data" / "site.json").read_text(encoding="utf-8"))
    with tempfile.TemporaryDirectory() as tmp:
        share_card(site, Path(tmp))
    icon(32, "favicon-32.png", rounded=True)
    icon(180, "apple-touch-icon.png", rounded=False)
    icon(192, "icon-192.png", rounded=False)
    icon(512, "icon-512.png", rounded=False)
    for p in sorted(OUT.glob("*.png")):
        print(f"wrote {p.relative_to(ROOT)} ({p.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
