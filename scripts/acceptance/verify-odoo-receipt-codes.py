"""Generate a synthetic Code128 fixture or decode actual browser JPEG output.

Test-only requirements: Pillow, reportlab, zxing-cpp==2.3.0. This does not
establish physical printer/scanner acceptance.
"""
import argparse
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--generate-svg", type=Path)
    group.add_argument("--verify-directory", type=Path)
    args = parser.parse_args()
    if args.generate_svg:
        from reportlab.graphics.barcode import createBarcodeDrawing
        drawing = createBarcodeDrawing("Code128", value="123456789012", barWidth=1,
                                       barHeight=36, humanReadable=False, quiet=True)
        args.generate_svg.write_text(drawing.asString("svg"), encoding="utf-8")
        return
    from PIL import Image
    import zxingcpp
    expected = {"YASEIR-GEOMETRY-TEST-20261019", "123456789012"}
    result = {"success": False, "scope": "Decoded digital JPEG pixels; no physical printer or scanner", "images": []}
    for path in sorted(args.verify_directory.glob("receipt-*.jpg")):
        with Image.open(path) as image:
            decoded = zxingcpp.read_barcodes(image)
            texts = {item.text for item in decoded}
            result["images"].append({"file": path.name, "size": list(image.size),
                                     "decoded": [{"text": item.text, "format": str(item.format),
                                                  "position": str(item.position)} for item in decoded],
                                     "expected_present": expected <= texts})
    assert result["images"], "No rendered JPEGs were produced"
    result["success"] = all(item["expected_present"] for item in result["images"])
    (args.verify_directory / "decoded-codes.json").write_text(json.dumps(result, indent=2) + "\n")
    assert result["success"], "A rendered receipt lost QR or Code128 content; inspect decoded-codes.json"


if __name__ == "__main__":
    main()
