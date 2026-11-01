"""Fetch only pinned upstream artifacts; never execute downloads automatically."""
import hashlib
import json
from pathlib import Path
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = ROOT / 'benchmarks/sources.json'
CACHE = ROOT / '.cache/benchmarks'

def fetch_sources():
    manifest = json.loads(MANIFEST.read_text())
    for source in manifest['sources']:
        for item in source['files']:
            path = CACHE / source['id'] / item['path']
            if path.exists() and hashlib.sha256(path.read_bytes()).hexdigest() == item['sha256']:
                continue
            for attempt in range(3):
                try:
                    request = urllib.request.Request(item['url'], headers={'User-Agent': 'Decision-Lab-conformance'})
                    with urllib.request.urlopen(request, timeout=60) as response:
                        data = response.read()
                    if hashlib.sha256(data).hexdigest() != item['sha256']:
                        raise ValueError('SHA256 mismatch: ' + item['url'])
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(data)
                    print('Fetched and verified', source['id'], item['path'], flush=True)
                    break
                except Exception:
                    if attempt == 2:
                        raise
                    time.sleep(1)
    return manifest

if __name__ == '__main__':
    fetch_sources()
    print('All pinned source hashes verified.')
