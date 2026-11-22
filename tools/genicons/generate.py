"""Generate unified Handraw multi-resolution icons from the master SVGs (#46).

Produces:
  - internal/desktop/icon.png           (512x512 RGBA from logo.svg)
  - internal/desktop/tray.png           (64x64 RGBA from optical-small logo-sm.svg)
  - packaging/windows/handraw.ico       (16, 24, 32 from logo-sm.svg; 48, 64, 128, 256 from logo.svg)
  - packaging/macos/handraw.icns        (icp4/16, icp5/32, icp6/64, ic07/128, ic08/256, ic09/512, ic10/1024)
  - Optional --web-out <dir>            (favicon.ico 16/32/48, apple-touch-icon.png 180x180 opaque vermilion)

Usage:
  python tools/genicons/generate.py
  python tools/genicons/generate.py --web-out ../handraw-web/demo/assets
"""
from __future__ import annotations

import argparse
import io
import struct
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
LOGO_MASTER = ROOT / "web" / "img" / "logo.svg"
LOGO_SMALL = ROOT / "web" / "img" / "logo-sm.svg"

# Full-bleed opaque vermilion variant for iOS apple-touch-icon (iOS masks corners itself;
# transparent corners would turn black on iOS home screen).
APPLE_TOUCH_SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" fill="none">
  <defs>
    <linearGradient id="hw-ios-bg" x1="0" y1="0" x2="128" y2="128" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#C94D30"/>
      <stop offset="50%" stop-color="#B74227"/>
      <stop offset="100%" stop-color="#9B331C"/>
    </linearGradient>
  </defs>
  <rect width="128" height="128" fill="url(#hw-ios-bg)"/>
  <path d="M51.8 87.6C43.2 81.8 29.6 82.6 23.0 89.6C17.0 95.8 19.2 105.4 30.0 107.6C44.4 110.5 64.2 101.6 81.2 97.4C88.8 95.5 95.0 96.4 96.6 99.6C97.3 101.0 96.2 103.2 94.6 104.4C99.2 103.8 103.6 99.6 102.2 94.4C100.6 88.6 91.4 86.6 79.2 89.6C63.8 93.4 46.8 100.4 35.8 98.6C29.8 97.6 28.6 93.2 33.4 90.2C38.2 87.2 46.0 87.2 51.4 89.0Z" fill="#FFFDF9"/>
  <g transform="translate(51.8 87.6) rotate(36)" stroke="#1E1B18" stroke-linecap="round" stroke-linejoin="round">
    <path d="M-8.8 -33.2C-9.8 -46.5 -9.4 -60.5 -8.0 -72.8C-7.2 -79.4 -4.2 -82.4 0 -82.4C4.2 -82.4 7.2 -79.4 8.0 -72.8C9.4 -60.5 9.8 -46.5 8.8 -33.2Z" fill="#FFFDF9" stroke-width="4.2"/>
    <path d="M-8.0 -66.8Q0 -69.2 8.0 -66.8" stroke-width="3.5"/>
    <path d="M0 0C-4.6 -7.8 -8.6 -14.2 -9.4 -19.2C-9.9 -22.2 -7.6 -26.4 -5.8 -29.2L5.8 -29.2C7.6 -26.4 9.9 -22.2 9.4 -19.2C8.6 -14.2 4.6 -7.8 0 0Z" fill="#FFFDF9" stroke-width="4.2"/>
    <path d="M0 -1.2L0 -15.4" stroke-width="2.8"/>
    <circle cx="0" cy="-17.6" r="2.4" fill="#FFFDF9" stroke-width="2.5"/>
    <path d="M-10.4 -31.8C-10.4 -35.4 -5.6 -37.2 0 -37.2C5.6 -37.2 10.4 -35.4 10.4 -31.8C10.4 -28.4 5.6 -27.2 0 -27.2C-5.6 -27.2 -10.4 -28.4 -10.4 -31.8Z" fill="#FFFDF9" stroke-width="4.2"/>
  </g>
</svg>
"""


def render_svg_png(browser, svg_text: str, size: int, supersample: int = 2) -> Image.Image:
    """Render SVG via Chromium Skia with supersampling and transparent background."""
    page = browser.new_page(
        viewport={"width": size, "height": size},
        device_scale_factor=supersample,
    )
    html = (
        "<!doctype html><html><head><style>"
        "html,body{margin:0;padding:0;width:100%;height:100%;background:transparent;overflow:hidden;}"
        "svg{display:block;width:100%;height:100%;}"
        f"</style></head><body>{svg_text}</body></html>"
    )
    page.set_content(html)
    raw = page.screenshot(omit_background=True, type="png")
    page.close()
    img = Image.open(io.BytesIO(raw)).convert("RGBA")
    if img.size != (size, size):
        img = img.resize((size, size), Image.Resampling.LANCZOS)
    return img


def write_ico(path: Path, images: list[Image.Image]) -> None:
    """Write a standard multi-resolution ICO with PNG payloads (Vista+ / Win10 / Win11)."""
    # Using PNG-compressed entries for 256px and 32-bit BMP (or PNG) for smaller sizes.
    # For maximum compatibility (including older Windows shell tools and Go winres),
    # encode <=48px as 32-bit BGRA BMP DIB with AND mask, and >=64px as PNG.
    entries: list[tuple[int, int, bytes]] = []
    for img in images:
        w, h = img.size
        assert w == h and w <= 256
        if w <= 48:
            # 32-bit BGRA DIB (height doubled for XOR + AND mask)
            pixels = img.tobytes("raw", "BGRA")
            # BMP rows are bottom-up
            row_bytes = w * 4
            xor_rows = b"".join(
                pixels[(y * row_bytes):((y + 1) * row_bytes)]
                for y in range(h - 1, -1, -1)
            )
            and_stride = ((w + 31) // 32) * 4
            and_rows = b"\x00" * (and_stride * h)
            header = struct.pack(
                "<IIIHHIIIIII",
                40,          # biSize
                w,           # biWidth
                h * 2,       # biHeight (XOR + AND)
                1,           # biPlanes
                32,          # biBitCount
                0,           # biCompression (BI_RGB)
                len(xor_rows) + len(and_rows),
                0, 0, 0, 0,
            )
            payload = header + xor_rows + and_rows
        else:
            buf = io.BytesIO()
            img.save(buf, format="PNG", optimize=True)
            payload = buf.getvalue()
        entries.append((w, h, payload))

    count = len(entries)
    out = bytearray(struct.pack("<HHH", 0, 1, count))
    offset = 6 + 16 * count
    for w, h, payload in entries:
        out.extend(struct.pack(
            "<BBBBHHII",
            0 if w == 256 else w,
            0 if h == 256 else h,
            0, 0, 1, 32,
            len(payload),
            offset,
        ))
        offset += len(payload)
    for _, _, payload in entries:
        out.extend(payload)

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(bytes(out))


def write_icns(path: Path, sized: dict[int, Image.Image]) -> None:
    """Write a macOS .icns container with standard PNG icon chunks (16..1024)."""
    type_map = [
        (16, b"icp4"),
        (32, b"icp5"),
        (64, b"icp6"),
        (128, b"ic07"),
        (256, b"ic08"),
        (512, b"ic09"),
        (1024, b"ic10"),
    ]
    body = bytearray()
    for sz, ostype in type_map:
        if sz not in sized:
            continue
        buf = io.BytesIO()
        sized[sz].save(buf, format="PNG", optimize=True)
        png = buf.getvalue()
        body.extend(ostype)
        body.extend(struct.pack(">I", 8 + len(png)))
        body.extend(png)
    total_len = 8 + len(body)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"icns" + struct.pack(">I", total_len) + bytes(body))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--web-out", type=Path, default=None, help="Optional directory to write favicon.ico & apple-touch-icon.png")
    args = parser.parse_args()

    master_svg = LOGO_MASTER.read_text(encoding="utf-8")
    small_svg = LOGO_SMALL.read_text(encoding="utf-8")

    with sync_playwright() as p:
        try:
            browser = p.chromium.launch(channel="msedge")
        except Exception:
            browser = p.chromium.launch()

        sm_16 = render_svg_png(browser, small_svg, 16, supersample=4)
        sm_24 = render_svg_png(browser, small_svg, 24, supersample=4)
        sm_32 = render_svg_png(browser, small_svg, 32, supersample=4)
        sm_64 = render_svg_png(browser, small_svg, 64, supersample=2)

        lg_48 = render_svg_png(browser, master_svg, 48, supersample=2)
        lg_64 = render_svg_png(browser, master_svg, 64, supersample=2)
        lg_128 = render_svg_png(browser, master_svg, 128, supersample=2)
        lg_256 = render_svg_png(browser, master_svg, 256, supersample=2)
        lg_512 = render_svg_png(browser, master_svg, 512, supersample=2)
        lg_1024 = render_svg_png(browser, master_svg, 1024, supersample=1)

        apple_180 = render_svg_png(browser, APPLE_TOUCH_SVG, 180, supersample=2).convert("RGB")
        browser.close()

    # Client embedded desktop icons
    icon_png = ROOT / "internal" / "desktop" / "icon.png"
    tray_png = ROOT / "internal" / "desktop" / "tray.png"
    lg_512.save(icon_png, format="PNG", optimize=True)
    sm_64.save(tray_png, format="PNG", optimize=True)

    # Windows multi-resolution .ico (16, 24, 32, 48, 64, 128, 256)
    win_ico = ROOT / "packaging" / "windows" / "handraw.ico"
    write_ico(win_ico, [sm_16, sm_24, sm_32, lg_48, lg_64, lg_128, lg_256])

    # macOS .icns (16..1024)
    mac_icns = ROOT / "packaging" / "macos" / "handraw.icns"
    write_icns(mac_icns, {
        16: sm_16,
        32: sm_32,
        64: lg_64,
        128: lg_128,
        256: lg_256,
        512: lg_512,
        1024: lg_1024,
    })

    print(f"Wrote {icon_png} ({icon_png.stat().st_size} bytes)")
    print(f"Wrote {tray_png} ({tray_png.stat().st_size} bytes)")
    print(f"Wrote {win_ico} ({win_ico.stat().st_size} bytes)")
    print(f"Wrote {mac_icns} ({mac_icns.stat().st_size} bytes)")

    if args.web_out:
        web_out = args.web_out.resolve()
        web_out.mkdir(parents=True, exist_ok=True)
        fav_ico = web_out / "favicon.ico"
        apple_png = web_out / "apple-touch-icon.png"
        write_ico(fav_ico, [sm_16, sm_32, lg_48])
        apple_180.save(apple_png, format="PNG", optimize=True)
        print(f"Wrote {fav_ico} ({fav_ico.stat().st_size} bytes)")
        print(f"Wrote {apple_png} ({apple_png.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
