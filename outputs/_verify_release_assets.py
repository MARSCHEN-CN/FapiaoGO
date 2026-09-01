import hashlib, base64, zipfile, os, json, time, re, sys

D = r'E:\print706\release_final_v5'
setup = os.path.join(D, 'FapiaoGO-Setup-1.0.0.exe')
portable = os.path.join(D, 'FapiaoGO-v1.0.0-Windows-x64-Portable.zip')


def h_of(p, algo):
    h = hashlib.new(algo)
    with open(p, 'rb') as f:
        for c in iter(lambda: f.read(1 << 20), b''):
            h.update(c)
    return h


r = {}
t0 = time.time()
r['setup_size'] = os.path.getsize(setup)
r['portable_size'] = os.path.getsize(portable)

h = h_of(setup, 'sha256'); r['setup_sha256'] = h.hexdigest()
r['setup_sha512_b64'] = base64.b64encode(h.copy().digest()).decode() if False else None
print('setup sha256', time.time() - t0, flush=True)

h2 = h_of(setup, 'sha512'); r['setup_sha512_b64'] = base64.b64encode(h2.digest()).decode()
print('setup sha512', time.time() - t0, flush=True)

r['portable_sha256'] = h_of(portable, 'sha256').hexdigest()
print('portable sha256', time.time() - t0, flush=True)

yml = open(os.path.join(D, 'latest.yml'), encoding='utf-8').read()
r['yml_size'] = int(re.search(r'size:\s*(\d+)', yml).group(1))
r['yml_sha512'] = re.search(r'sha512:\s*(\S+)', yml).group(1)
r['yml_version'] = re.search(r'version:\s*(\S+)', yml).group(1)

t = time.time()
with zipfile.ZipFile(portable) as z:
    infos = z.infolist()
    r['zip_entries'] = len(infos)
    bad = z.testzip()
r['zip_crc_bad'] = bad
r['zip_crc_ok'] = bad is None
print('zip crc', time.time() - t, flush=True)

r['MATCH_setup_sha256_vs_sums'] = (r['setup_sha256'] == '5213a4411162719a6f22fb5acd0aeb2bfde5802f74bb52aa847cd88b32e61626')
r['MATCH_portable_sha256_vs_sums'] = (r['portable_sha256'] == '488c398fdd5a706b73b26e0e6b77b98fdb6b45f65d34baccae28067568eb2520')
r['MATCH_yml_size'] = (r['yml_size'] == r['setup_size'])
r['MATCH_yml_sha512'] = (r['yml_sha512'] == r['setup_sha512_b64'])

print(json.dumps(r, indent=2, ensure_ascii=False))
with open(r'E:\print706\outputs\_v5_asset_verify.json', 'w', encoding='utf-8') as f:
    json.dump(r, f, indent=2, ensure_ascii=False)
