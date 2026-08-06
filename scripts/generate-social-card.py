from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "scripts/assets/hyperstrike-social-source.png"
MARK = ROOT / "apps/web/public/brand/hyperstrike-mark.png"
OUTPUT = ROOT / "apps/web/public/brand/hyperstrike-social-card.png"

WIDTH, HEIGHT = 1200, 630
MINT = "#A7FFF1"
ORANGE = "#E89A42"
PAPER = "#F2FFFC"


def font(path_candidates: list[str], size: int) -> ImageFont.FreeTypeFont:
    for candidate in path_candidates:
        path = Path(candidate)
        if path.exists():
            return ImageFont.truetype(str(path), size=size)
    return ImageFont.load_default(size=size)


bold = font([
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial Black.ttf",
], 72)
label = font(["/System/Library/Fonts/Supplemental/Arial Bold.ttf"], 23)
small = font(["/System/Library/Fonts/Supplemental/Arial Bold.ttf"], 17)

source = Image.open(SOURCE).convert("RGB")
target_ratio = WIDTH / HEIGHT
crop_height = round(source.width / target_ratio)
top = max(0, (source.height - crop_height) // 2)
source = source.crop((0, top, source.width, top + crop_height)).resize((WIDTH, HEIGHT), Image.Resampling.LANCZOS)
source = ImageEnhance.Contrast(source).enhance(1.04)

overlay = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
draw = ImageDraw.Draw(overlay)
for x in range(660):
    alpha = int(226 * (1 - x / 660) ** 1.45)
    draw.line((x, 0, x, HEIGHT), fill=(2, 10, 13, alpha))
draw.rectangle((0, 0, WIDTH, 7), fill=ORANGE)

mark = Image.open(MARK).convert("RGBA").resize((104, 104), Image.Resampling.LANCZOS)
mark = mark.filter(ImageFilter.UnsharpMask(radius=1.2, percent=130, threshold=2))
overlay.alpha_composite(mark, (58, 54))

draw.text((180, 63), "HYPERSTRIKE", font=bold, fill=PAPER, stroke_width=2, stroke_fill="#07191E")
draw.rectangle((181, 142, 455, 149), fill=ORANGE)
draw.text((62, 208), "ENTER THE SKIN RANGE", font=label, fill=MINT)
draw.multiline_text(
    (60, 258),
    "THE BALLISTIC\nPREDICTION MARKET\nFOR CS2 SKIN PRICES",
    font=label,
    fill=PAPER,
    spacing=14,
)
draw.rounded_rectangle((59, 480, 420, 533), radius=5, outline=(142, 245, 227, 150), width=2, fill=(4, 20, 24, 180))
draw.text((82, 496), "AIM  ·  FIRE  ·  TRADE ON HIP-4", font=small, fill=MINT)
draw.text((62, 568), "HYPERSTRIKE.GG", font=small, fill=ORANGE)

card = Image.alpha_composite(source.convert("RGBA"), overlay).convert("RGB")
card.save(OUTPUT, format="PNG", optimize=True)
print(OUTPUT)
