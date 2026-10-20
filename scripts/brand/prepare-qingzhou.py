"""Extract original Qingzhou watercolors without regenerating the lettering.
Run: python scripts/brand/prepare-qingzhou.py [source directory]
"""
from pathlib import Path
import sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

source = Path(sys.argv[1]) if len(sys.argv) > 1 else Path('/home/shiro/July/清舟设计')
output = Path(__file__).resolve().parents[2] / 'public/brand/qingzhou-watercolor'
generated = Path(__file__).resolve().parents[2] / 'output/imagegen'
output.mkdir(parents=True, exist_ok=True)
seal = Image.open(source / '46780E90D853AC2E2538F1FBCFF61F05.png').convert('RGB')
wheel = Image.open(source / '92476cd9-64ef-4828-94f8-b8df8f949854.png').convert('RGB')

def extract(im, box, name, polygon=None, size=None):
    crop = im.crop(box)
    rgb = np.asarray(crop).astype(float)
    high, low = rgb.max(axis=2), rgb.min(axis=2)
    # Both the white paper and the baked checkerboard are neutral. Retain
    # colored watercolor coverage, removing neutral pixels without hard halos.
    alpha = np.clip((high - low - 4) / 135, 0, 1)
    if name.startswith("letter-"):
        alpha *= np.clip((175 - low) / 45, 0, 1)
    if polygon:
        mask = Image.new('L', im.size)
        ImageDraw.Draw(mask).polygon(polygon, fill=255)
        alpha *= np.asarray(mask.crop(box).filter(ImageFilter.GaussianBlur(.6))) / 255
    safe = np.maximum(alpha, 1 / 255)
    color = np.clip((rgb - high[..., None] * (1 - safe[..., None])) / safe[..., None], 0, 255)
    rgba = np.dstack((color, alpha * 255)).astype('uint8')
    asset = Image.fromarray(rgba)
    if size: asset.thumbnail(size, Image.Resampling.LANCZOS)
    asset.save(output / name, lossless=True)
    print(name, asset.size, (output / name).stat().st_size)
    return asset

def extract_paper_wash(source_path, name):
    """Turn a generated white-paper watercolor wash into a reusable alpha layer."""
    rgb = np.asarray(Image.open(source_path).convert('RGB')).astype(float)
    chroma = rgb.max(axis=2) - rgb.min(axis=2)
    alpha = np.clip((chroma - 2) / 52, 0, 1) ** .9
    rgba = np.dstack((rgb, alpha * 255)).astype('uint8')
    asset = Image.fromarray(rgba)
    asset.save(output / name, quality=82, method=6)
    print(name, asset.size, (output / name).stat().st_size)

qing = extract(seal, (283,390,578,790), 'letter-qing.webp', [(381,390),(461,410),(502,435),(510,478),(579,500),(578,555),(512,579),(507,699),(495,790),(405,789),(355,735),(354,651),(356,600),(341,572),(303,639),(284,636),(284,527),(297,520),(291,501),(283,443),(319,434),(358,456),(381,451)])
zhou = extract(seal, (548,497,847,793), 'letter-zhou.webp', [(672,497),(720,512),(729,552),(765,545),(789,567),(788,605),(847,617),(847,680),(818,681),(818,749),(797,793),(727,793),(678,745),(616,786),(548,793),(548,770),(597,728),(625,688),(562,708),(548,691),(548,656),(629,630),(636,591),(656,562)])
wordmark = Image.new('RGBA', (646,420))
wordmark.alpha_composite(qing, (8,10))
wordmark.alpha_composite(zhou, (325,111))
wordmark.save(output / 'wordmark.webp', lossless=True)
extract(seal, (456,309,566,417), 'leaf.webp', [(464,410),(466,366),(488,340),(528,326),(563,310),(546,350),(522,377),(486,390)])
extract(seal, (766,835,868,888), 'boat.webp', [(767,846),(807,853),(843,837),(839,850),(867,850),(847,870),(821,885),(797,875)], size=(204,106))
extract(wheel, (0,0,1024,1024), 'ferris-original.webp', size=(900,900))
extract(wheel, (474,24,551,129), 'cabin.webp', [(480,32),(521,24),(539,35),(540,50),(548,70),(549,114),(535,121),(521,129),(491,118),(478,110),(474,67)])
extract(wheel, (553,398,636,489), 'hub.webp')
extract(wheel, (306,737,989,983), 'foliage.webp', [(318,953),(332,919),(406,846),(543,826),(625,737),(688,743),(744,790),(826,777),(929,738),(989,777),(961,968),(791,983),(556,967)])

presentation_mist = generated / 'qingzhou-presentation-mist.png'
if presentation_mist.exists():
    extract_paper_wash(presentation_mist, 'presentation-mist.webp')
