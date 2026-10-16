#!/usr/bin/env python3
"""Real FSEvents regression checks. All mutations stay inside a disposable owned fixture."""
import argparse
import base64
import importlib.util
import json
import hashlib
import fcntl
import os
from pathlib import Path
import shutil
import statistics
import subprocess
import sys
import tempfile
import time

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('metadata_bench', Path(__file__).resolve().parents[2] / 'scripts/bench-macos-metadata.py')
bench = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bench)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('binary', type=Path)
    parser.add_argument('--folders', type=int, default=300)
    parser.add_argument('--files-per-folder', type=int, default=20)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    assert sys.platform == 'darwin', 'This test requires real macOS FSEvents'
    binary = args.binary.resolve()
    report = dict(checks=[], timings=[])
    with tempfile.TemporaryDirectory(prefix='disk-watch-incremental-') as temporary:
        base = Path(temporary).resolve()
        root, state = base / 'root', base / 'state'
        root.mkdir()
        (base / 'sentinel').write_bytes(b'outside sentinel')
        for directory in range(args.folders):
            folder = root / f'd{directory:05}'
            folder.mkdir()
            for file in range(args.files_per_folder):
                (folder / f'f{file:03}').write_bytes(b'x' * 20)
        (root / 'unicode-é').mkdir()
        (root / 'unicode-é' / 'leaf').write_bytes(b'unicode')
        os.symlink(base / 'sentinel', root / 'outside-link')
        os.mkfifo(root / 'fifo')
        worker = None

        def operation(name, **parameters):
            request = dict(v=1, requestId='incremental-test', op=name, **parameters)
            if worker:
                request['expectedWorker'] = dict(id=worker['id'], account=worker['account'])
            return bench.operation(binary, state, request)

        worker = operation('hello')[0][-1]['value']
        observed = operation('inspect', path=str(root))[0][-1]['value']
        assert observed['filesystem'] == 'apfs'
        options = dict(root=observed, excludes=[], minFileSize=30)

        def scan(incremental, label):
            frames, timing = operation('scan', **options, incremental=incremental)
            report['timings'].append(dict(case=label, incremental=incremental, **timing, method=frames[-1]['method']))
            return frames

        def compare(label):
            quick = scan(True, label)
            full = scan(False, label)
            assert bench.captured_tree(quick) == bench.captured_tree(full), label
            for field in ('size', 'files', 'dirs', 'errors', 'coverage', 'skipped'):
                assert quick[-1][field] == full[-1][field], (label, field, quick[-1], full[-1])
            report['checks'].append(label)
            print(f'{label}: {quick[-1]["method"]}, {quick[-1]["ms"]} ms; full {full[-1]["ms"]} ms', flush=True)
            return quick

        baseline = compare('initial baseline')
        assert baseline[-1]['method'] == 'walk' and baseline[-1]['fallback']
        repeat = compare('unchanged')
        assert repeat[-1]['method'] == 'incremental', repeat[-1]
        cache = next((state / 'scan-cache-v1').glob('*.cache'))
        before = cache.read_bytes()
        child = subprocess.Popen([str(binary), '--worker', '--state-dir', str(state)],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        child.stdin.write((json.dumps(dict(v=1, requestId='cancel-test', op='scan',
                         expectedWorker=dict(id=worker['id'], account=worker['account']),
                         **options, incremental=True)) + '\n').encode())
        child.stdin.flush()
        assert json.loads(child.stdout.readline())['t'] == 'hello'
        assert json.loads(child.stdout.readline())['t'] == 'root'
        child.stdin.write(b'{"op":"cancel","requestId":"cancel-test"}\n')
        child.stdin.close()
        child.stdin = None
        child.communicate(timeout=10)
        assert child.returncode != 0 and cache.read_bytes() == before
        compare('cancelled quick scan preserved baseline')
        for index in range(2):
            compare(f'unchanged repeat {index}')
        for index in range(5):
            # A content write does not change the containing directory's mtime.
            (root / 'd00000' / 'f000').write_bytes(b'changed' * (index + 10))
            compare(f'immediate content write {index}')
        (root / 'unicode-é' / 'leaf').write_bytes(b'updated unicode')
        compare('unicode directory change')
        (root / 'd00001').rename(root / 'renamed')
        (root / 'new' / 'deep').mkdir(parents=True)
        (root / 'new' / 'deep' / 'leaf').write_bytes(b'new file')
        (root / 'd00002' / 'f000').unlink()
        compare('rename creation deletion')
        shutil.rmtree(root / 'd00003')
        os.symlink(base, root / 'd00003')
        compare('directory replaced by outside symlink')
        (root / 'd00004' / 'alias').hardlink_to(base / 'sentinel')
        compare('hard link baseline')
        (base / 'sentinel').write_bytes(b'outside hard link changed')
        compare('hard link write through outside name')
        private = root / 'd00005'
        private.chmod(0)
        try:
            partial = compare('permission denied')
            assert partial[-1]['coverage'] == 'partial'
            compare('repeated permission denied')
        finally:
            private.chmod(0o700)
        compare('permission restored')
        future = root / 'd00007' / 'future-dated'
        future.write_bytes(b'future file' * 10)
        stamp = time.time() + 1
        os.utime(future, (stamp, stamp))
        compare('future timestamp')
        time.sleep(1)
        compare('future timestamp became valid without another write')
        options['excludes'] = [[base64.b64encode(b'd00006').decode()]]
        assert compare('changed exclusions')[-1]['method'] == 'walk'
        options['minFileSize'] = 1
        assert compare('changed grouping threshold')[-1]['method'] == 'walk'
        cache = next((state / 'scan-cache-v1').glob('*.cache'))
        cache.write_bytes(b'incomplete cache')
        assert compare('truncated cache recovery')[-1]['method'] == 'walk'
        def edit_header(change):
            lines = cache.read_bytes().splitlines(keepends=True)
            header = json.loads(lines[0])
            change(header)
            lines[0] = (json.dumps(header, separators=(',', ':')) + '\n').encode()
            body = b''.join(lines[:-1])
            cache.write_bytes(body + f'sha256:{hashlib.sha256(body).hexdigest()}\n'.encode())
        edit_header(lambda header: header.update(full_at=1))
        assert compare('expired baseline')[-1]['method'] == 'walk'
        edit_header(lambda header: header['key'].update(uuid='different-volume'))
        assert compare('changed volume UUID')[-1]['method'] == 'walk'
        data = cache.read_bytes()
        cache.write_bytes(data[:-2] + (b'0' if data[-2:-1] != b'0' else b'1') + b'\n')
        assert compare('checksum mismatch')[-1]['method'] == 'walk'
        cache.unlink()
        os.symlink(base / 'sentinel', cache)
        assert compare('cache symlink replacement')[-1]['method'] == 'walk'
        lock = next((state / 'scan-cache-v1').glob('*.lock'))
        with lock.open('rb') as held:
            fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
            assert compare('concurrent baseline writer')[-1]['method'] == 'walk'
        abandoned = cache.with_suffix('.tmp-999999')
        abandoned.touch(mode=0o600)
        compare('abandoned cache write recovery')
        assert not abandoned.exists()
        # The generation limit causes a periodic full refresh even on a quiet volume.
        methods = [scan(True, 'periodic refresh')[-1]['method'] for _ in range(12)]
        assert 'walk' in methods and 'incremental' in methods, methods
        report['checks'].append('periodic full refresh')
        assert (base / 'sentinel').read_bytes() == b'outside hard link changed'
        report['outsideSentinelPreserved'] = True
    report['ownedFixtureRemoved'] = not base.exists()
    report['unchangedMedianWallMs'] = {str(quick): statistics.median(row['wallMs'] for row in report['timings'] if row['case'].startswith('unchanged') and row['incremental'] == quick) for quick in [False, True]}
    if args.output:
        args.output.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(dict(checks=len(report['checks']), outsideSentinelPreserved=True, ownedFixtureRemoved=report['ownedFixtureRemoved'])))


if __name__ == '__main__':
    main()
