"""Generate the WP7 real-content receipt fixture (sandbox tooling only).

Renders shaped Arabic (PIL + raqm + Noto Naskh Arabic), English, digits, a
real QR code and a real Code128 barcode onto a 576px-wide white raster —
the 80mm thermal width class at 203dpi. Output: wp7_receipt_576.png next
to this script. Requires: pillow with raqm, qrcode, python-barcode.
Not a product dependency; the Go quality suite reads the PNG only.
"""
import os
import qrcode
from barcode import Code128
from barcode.writer import ImageWriter
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
W = 576
AR = "/usr/share/fonts/truetype/noto/NotoNaskhArabic-Regular.ttf"
AR_BOLD = "/usr/share/fonts/truetype/noto/NotoNaskhArabic-Bold.ttf"
LATIN = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
LATIN_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"

img = Image.new("RGB", (W, 1400), "white")
d = ImageDraw.Draw(img)
y = 16


def ar_text(text, size, bold=False, x_right=W - 16):
    f = ImageFont.truetype(AR_BOLD if bold else AR, size)
    d.text((x_right, y), text, font=f, fill="black", direction="rtl",
           language="ar", anchor="ra")
    return f.getbbox(text)


def latin(text, size, bold=False, x=16):
    f = ImageFont.truetype(LATIN_BOLD if bold else LATIN, size)
    d.text((x, y), text, font=f, fill="black", anchor="la")
    return f


# Title + diacritic/ligature lines (right-aligned Arabic).
ar_text("فاتورة ضريبية", 44, bold=True)
y += 62
ar_text("السَّلامُ عَلَيْكُم — مُحَمَّد", 30)
y += 48
ar_text("صنف تجريبي  ١٢٫٥٠ ر.س", 30)
y += 48
ar_text("الإجمالي  ١٢٣٫٤٥ ر.س", 30, bold=True)
y += 56
latin("TOTAL 123.45 SAR", 26, bold=True)
y += 44
latin("Item 001 x2  24.90  |  VAT 15%", 22)
y += 40
d.line([(16, y), (W - 16, y)], fill="black", width=2)
y += 16

# Real QR code, integer 6px modules, 4-module quiet zone.
qr = qrcode.QRCode(box_size=6, border=4)
qr.add_data("https://yaseir.example/inv/12345")
qr.make()
qr_img = qr.make_image(fill_color="black", back_color="white").convert("RGB")
img.paste(qr_img, (16, y))
qr_bottom = y + qr_img.height
# Real Code128 barcode below the QR. python-barcode sizes are in mm at
# the writer DPI (300): 0.22mm modules render at ~2.6px, so the whole
# symbol fits the 576px paper with quiet zones. A barcode wider than the
# paper would be silently clipped by paste() — fail loudly instead.
bc = Code128("123456789012", writer=ImageWriter())
bc_img = bc.render(writer_options={"module_width": 0.22, "module_height": 10,
                                    "quiet_zone": 6, "font_size": 0,
                                    "text_distance": 0})
bc_img = bc_img.convert("RGB")
assert bc_img.width <= W - 32, f"barcode {bc_img.width}px exceeds paper"
img.paste(bc_img, (16, qr_bottom + 16))
y = qr_bottom + 16 + bc_img.height + 16
d.line([(16, y), (W - 16, y)], fill="black", width=2)
y += 16
ar_text("شكراً لكم", 30)
y += 48
latin("Thank you", 22)
y += 40

img = img.crop((0, 0, W, y + 16))
out = os.path.join(HERE, "wp7_receipt_576.png")
img.save(out)
print(f"wrote {out} size={img.size}")
