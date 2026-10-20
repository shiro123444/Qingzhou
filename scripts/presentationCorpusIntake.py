"""Create a resumable local manifest without modifying the supplied originals."""
import argparse
import hashlib
import json
import shutil
import subprocess
import tempfile
from pathlib import Path
from zipfile import ZipFile

parser = argparse.ArgumentParser()
parser.add_argument('source', type=Path)
parser.add_argument('output', type=Path)
parser.add_argument('--office', default=r'C:\Program Files\LibreOffice\program\soffice.com')
args = parser.parse_args()
source = args.source.resolve(strict=True)
output = args.output.resolve()
if output == source or source in output.parents:
    raise ValueError('The intake output must be outside the original source directory')
output.mkdir(parents=True, exist_ok=True)
staging = output / 'sources'
staging.mkdir(exist_ok=True)
records = []
errors = []
for file in sorted(source.rglob('*')):
    if not file.is_file() or file.name.startswith('~$'):
        continue
    if file.suffix.lower() == '.pptx':
        records.append({'path': str(file), 'source': str(file.relative_to(source)), 'name': file.stem})
    elif file.suffix.lower() == '.zip':
        with ZipFile(file) as archive:
            for item in archive.infolist():
                if not item.filename.lower().endswith('.pptx') or Path(item.filename.replace('\\', '/')).name.startswith('~$') or item.file_size < 1000 or item.file_size > 512 * 1024**2:
                    continue
                label = item.filename
                if not item.flag_bits & 0x800:
                    try:
                        label = label.encode('cp437').decode('gbk')
                    except UnicodeError:
                        pass
                key = hashlib.sha256((str(file) + '\0' + item.filename + '\0' + str(item.CRC)).encode()).hexdigest()
                target = staging / (key + '.pptx')
                if not target.exists():
                    temporary = target.with_suffix('.tmp')
                    with archive.open(item) as incoming, temporary.open('wb') as destination:
                        shutil.copyfileobj(incoming, destination, 1024 * 1024)
                    temporary.replace(target)
                records.append({'path': str(target), 'source': file.name + '::' + label, 'name': Path(label.replace('\\', '/')).stem})
    elif file.suffix.lower() == '.ppt':
        key = hashlib.sha256(file.read_bytes()).hexdigest()
        conversion = staging / key
        conversion.mkdir(exist_ok=True)
        target = conversion / (file.stem + '.pptx')
        try:
            if not target.exists():
                with tempfile.TemporaryDirectory(prefix='legacy-', dir=output) as temporary:
                    work = Path(temporary).resolve()
                    if not work.is_relative_to(output):
                        raise ValueError('Temporary conversion must stay in the intake directory')
                    shutil.copyfile(file, work / 'source.ppt')
                    subprocess.run([args.office, '-env:UserInstallation=' + (work / 'profile').as_uri(), '--headless', '--convert-to', 'pptx', '--outdir', str(work), str(work / 'source.ppt')], check=True, timeout=120, capture_output=True)
                    shutil.copyfile(work / 'source.pptx', target)
            if not target.exists():
                raise RuntimeError('Legacy PPT conversion produced no PPTX')
            records.append({'path': str(target), 'source': file.name, 'name': file.stem, 'convertedFromLegacy': True})
        except Exception as error:
            errors.append({'source': file.name, 'error': str(error)})
manifest = {'source': str(source), 'records': records, 'errors': errors}
(output / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({'sources': len(records), 'errors': errors}, ensure_ascii=False))
