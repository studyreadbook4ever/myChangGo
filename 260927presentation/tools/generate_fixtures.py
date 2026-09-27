#!/usr/bin/env python3
"""Generate original, deterministic PDF fixtures with the Python standard library.

No downloaded font, template, photograph, or third-party PDF library is used.
The font references are PDF's standard base fonts; no font binaries are embedded.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def text(x: float, y: float, size: int, value: str, bold: bool = False,
         color: str = '0.10 0.16 0.24') -> str:
    escaped = value.replace('\\', '\\\\').replace('(', '\\(').replace(')', '\\)')
    return f'{color} rg BT /F{2 if bold else 1} {size} Tf {x:g} {y:g} Td ({escaped}) Tj ET\n'


def rect(x: float, y: float, w: float, h: float, color: str) -> str:
    return f'{color} rg {x:g} {y:g} {w:g} {h:g} re f\n'


def page_content(number: int) -> bytes:
    """Original vector slide artwork in a 960 x 540 design coordinate system."""
    out = rect(0, 0, 960, 540, '0.96 0.97 0.98')
    out += rect(0, 0, 12, 540, '0.16 0.42 0.47')
    out += text(60, 486, 12, 'PRESENTATION STUDIO  /  DEMO', True, '0.16 0.42 0.47')
    out += text(858, 486, 12, f'0{number} / 03', False, '0.40 0.47 0.52')
    if number == 1:
        out += text(60, 360, 54, 'Your slides.', True)
        out += text(60, 296, 54, 'Your voice.', True)
        out += text(62, 223, 21, 'One calm place to record your next presentation.')
        out += rect(62, 112, 352, 50, '0.16 0.42 0.47')
        out += text(82, 130, 17, 'A private script. A clean 16:9 video.', True, '1 1 1')
        # Entirely original vector landscape, no downloaded artwork.
        out += rect(648, 185, 240, 218, '0.84 0.92 0.93')
        out += '0.98 0.74 0.35 rg 812 349 m 812 366 798 380 781 380 c 764 380 750 366 750 349 c 750 332 764 318 781 318 c 798 318 812 332 812 349 c f\n'
        out += '0.41 0.65 0.64 rg 648 185 m 648 261 l 710 323 l 802 185 l h f\n'
        out += '0.16 0.42 0.47 rg 700 185 m 813 296 l 888 232 l 888 185 l h f\n'
    elif number == 2:
        out += text(60, 387, 43, 'Less setup. More clarity.', True)
        labels = [('01', 'Open your PDF', 'Keep the layout you designed.'),
                  ('02', 'Prepare your words', 'Your script stays beside the slide.'),
                  ('03', 'Record at your pace', 'Pause, change slides, and resume.')]
        for idx, (n, title, detail) in enumerate(labels):
            x = 60 + idx * 290
            out += rect(x, 139, 260, 186, '0.89 0.94 0.95')
            out += text(x + 18, 273, 28, n, True, '0.16 0.42 0.47')
            out += text(x + 18, 224, 19, title, True)
            out += text(x + 18, 185, 11, detail)
    else:
        out += text(60, 385, 44, 'Ready when you are.', True)
        out += text(62, 334, 20, 'A short check before the real take.')
        rows = [('OUTPUT', '1280 x 720  /  MP4'),
                ('SLIDES', 'Your PDF pages, in order'),
                ('SCRIPT & CONTROLS', 'For your eyes only')]
        for idx, (label, value) in enumerate(rows):
            y = 245 - idx * 62
            out += rect(60, y - 14, 840, 52, '0.89 0.94 0.95' if idx % 2 == 0 else '0.94 0.96 0.97')
            out += text(78, y + 4, 13, label, True, '0.16 0.42 0.47')
            out += text(350, y + 2, 18, value)
    out += text(62, 43, 11, 'Original sample artwork  /  No embedded fonts or private notes.', False, '0.40 0.47 0.52')
    return out.encode('ascii')


def pdf(width: int = 960, height: int = 540, rotation: int = 0,
        prefix: bytes = b'', pages: int = 3) -> bytes:
    """Minimal PDF 1.4 with correct cross-reference offsets and explicit page boxes."""
    font_regular = 3 + pages * 2
    font_bold = font_regular + 1
    kids = ' '.join(f'{3 + idx * 2} 0 R' for idx in range(pages))
    objs = [b'<< /Type /Catalog /Pages 2 0 R >>',
            f'<< /Type /Pages /Kids [{kids}] /Count {pages} >>'.encode()]
    for idx in range(pages):
        stream = f'q {width/960:g} 0 0 {height/540:g} 0 0 cm\n'.encode() + page_content(idx+1) + b'Q\n'
        page = (f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {width} {height}] '
                f'/Rotate {rotation} /Resources << /Font << /F1 {font_regular} 0 R /F2 {font_bold} 0 R >> >> '
                f'/Contents {4 + idx * 2} 0 R >>')
        objs.append(page.encode())
        objs.append(f'<< /Length {len(stream)} >>\nstream\n'.encode() + stream + b'endstream')
    objs.extend([b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
                 b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>'])
    out = bytearray(prefix + b'%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')
    offsets = [0]
    for idx, obj in enumerate(objs, 1):
        offsets.append(len(out))
        out.extend(f'{idx} 0 obj\n'.encode() + obj + b'\nendobj\n')
    start = len(out)
    out.extend(f'xref\n0 {len(objs)+1}\n0000000000 65535 f \n'.encode())
    for off in offsets[1:]:
        out.extend(f'{off:010d} 00000 n \n'.encode())
    out.extend(f'trailer\n<< /Size {len(objs)+1} /Root 1 0 R >>\nstartxref\n{start}\n%%EOF\n'.encode())
    return bytes(out)


def fixtures() -> dict[str, bytes]:
    return {
        'demo.pdf': pdf(),
        'demo-4x3.pdf': pdf(720, 540),
        'demo-portrait.pdf': pdf(540, 960),
        'demo-rotated.pdf': pdf(540, 960, rotation=90),
        'demo-prefixed.pdf': pdf(prefix=b'% Original harmless prefix before the PDF signature.\n'),
        'malformed.pdf': b'%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 99 0 R >>\nendobj\n%%EOF\n',
        'not-a-pdf.pdf': b'This intentionally is not a PDF document.\n',
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='verify committed files without rewriting')
    args = parser.parse_args()
    files = fixtures()
    manifest = {name: {'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}
                for name, data in sorted(files.items())}
    files['manifest.json'] = (json.dumps(manifest, indent=2, sort_keys=True)+'\n').encode()
    target = ROOT/'samples'
    target.mkdir(exist_ok=True)
    for name, data in files.items():
        if args.check:
            if not (target/name).exists() or (target/name).read_bytes() != data:
                raise SystemExit(f'Fixture differs: {name}; regenerate with tools/generate_fixtures.py')
        else:
            (target/name).write_bytes(data)
    print(f'{"Verified" if args.check else "Generated"} {len(files)-1} deterministic fixtures and manifest.')


if __name__ == '__main__':
    main()
