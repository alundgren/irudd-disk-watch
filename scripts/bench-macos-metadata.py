#!/usr/bin/env python3
"""Compare two native workers on the same owned APFS fixtures, without GUI or elevation."""
import argparse
import base64
import json
import os
from pathlib import Path
import statistics
import subprocess
import sys
import tempfile
import threading
import time


def operation(binary, state, request):
    started = time.perf_counter()
    process = subprocess.Popen([str(binary), '--worker', '--state-dir', str(state)],
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    stopped = threading.Event()
    diagnostics = bytearray()

    def heartbeat():
        while not stopped.wait(2):
            try:
                process.stdin.write((json.dumps(dict(op='ping', requestId=request['requestId'])) + '\n').encode())
                process.stdin.flush()
            except (BrokenPipeError, ValueError):
                return

    def errors():
        for block in iter(lambda: process.stderr.read(4096), b''):
            diagnostics.extend(block[:max(0, 65536 - len(diagnostics))])

    readers = [threading.Thread(target=heartbeat), threading.Thread(target=errors)]
    deadline = threading.Timer(60, process.kill)
    try:
        process.stdin.write((json.dumps(request) + '\n').encode())
        process.stdin.flush()
        for reader in readers:
            reader.start()
        deadline.start()
        records = []
        for line in process.stdout:
            assert len(line) <= 4 * 1024 * 1024 + 1
            records.append(json.loads(line))
        _, status, usage = os.wait4(process.pid, 0)
        process.returncode = os.waitstatus_to_exitcode(status)
        assert process.returncode == 0, (process.returncode, diagnostics.decode())
        assert records[0]['t'] == 'hello' and records[-1]['t'] in ('result', 'done')
        return records, dict(wallMs=(time.perf_counter() - started) * 1000,
                             nativeMs=records[-1].get('ms'), peakRssBytes=usage.ru_maxrss,
                             userCpuMs=usage.ru_utime * 1000, systemCpuMs=usage.ru_stime * 1000)
    finally:
        stopped.set()
        deadline.cancel()
        if process.returncode is None:
            process.kill()
            process.wait()
        for reader in readers:
            if reader.ident is not None:
                reader.join()
        for stream in (process.stdin, process.stdout, process.stderr):
            stream.close()


def captured_tree(records):
    parents, captured = {}, {}
    for row in records:
        kind = row['t']
        if kind not in ('dir', 'file', 'rest'):
            continue
        parent = row.get('parent')
        parts = () if parent is None else parents[parent]
        if parent is not None and kind != 'rest':
            parts += (row['nameBytes'],)
        if kind == 'dir':
            parents[row['id']] = parts
        key = (parts, kind)
        assert key not in captured, ('duplicate node', key)
        captured[key] = {key: value for key, value in row.items() if key not in ('id', 'parent')}
    return captured


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('baseline', type=Path)
    parser.add_argument('candidate', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if sys.platform != 'darwin':
        parser.error('This benchmark measures macOS native workers only.')
    binaries = dict(baseline=args.baseline.resolve(strict=True), candidate=args.candidate.resolve(strict=True))
    proof = dict(cache='Warm-cache runs after fixture creation; no cache flushing or cold-cache claim.', cases=[])
    with tempfile.TemporaryDirectory(prefix='disk-watch-metadata-bench-') as temporary:
        base = Path(temporary).resolve()
        state = base / 'state'
        state.mkdir(mode=0o700)
        sentinel = base / 'outside'
        sentinel.mkdir(mode=0o700)
        (sentinel / 'sentinel').write_bytes(b'outside remains unchanged')
        hello, _ = operation(binaries['baseline'], state, dict(v=1, requestId='bench', op='hello'))
        worker = hello[-1]['value']
        binding = dict(id=worker['id'], account=worker['account'])
        for name, folders, small_per_folder in [('nested', 500, 200), ('wide', 1, 50000)]:
            root = base / name
            root.mkdir(mode=0o700)
            for number in range(folders):
                folder = root / str(number) if folders > 1 else root
                if folders > 1:
                    folder.mkdir(mode=0o700)
                for leaf in range(small_per_folder):
                    (folder / f'f{leaf}').write_bytes(b'x' * 128)
            for number in range(100):
                with (root / f'large-{number}').open('xb') as sparse:
                    sparse.truncate(2 * 1024 * 1024)
            (root / 'link').symlink_to(sentinel, target_is_directory=True)
            (root / 'excluded').write_bytes(b'excluded')
            inspect, _ = operation(binaries['baseline'], state, dict(v=1, requestId='bench', op='inspect',
                                                                    expectedWorker=binding, path=str(root)))
            observed = inspect[-1]['value']
            assert observed['filesystem'] == 'apfs', observed['filesystem']
            expected_files = folders * small_per_folder + 100
            expected_bytes = folders * small_per_folder * 128 + 100 * 2 * 1024 * 1024
            case = dict(name=name, files=expected_files, logicalBytes=expected_bytes, runs=[])
            original = None
            for repetition in range(5):
                order = ['baseline', 'candidate'] if repetition % 2 == 0 else ['candidate', 'baseline']
                for label in order:
                    request = dict(v=1, requestId='bench', op='scan', expectedWorker=binding, root=observed,
                                   excludes=[[base64.b64encode(b'excluded').decode()]], minFileSize=1024 * 1024)
                    records, measurement = operation(binaries[label], state, request)
                    done = records[-1]
                    assert (done['size'], done['files'], done['errors'], done['coverage']) == (
                        expected_bytes, expected_files, 0, 'complete'), done
                    assert done['skipped'] == dict(symlinks=1, special=0, mounts=0), done
                    captured = captured_tree(records)
                    if original is None:
                        original = captured
                    assert captured == original, 'Captured paths, identities, times, or totals differ'
                    case['runs'].append(dict(binary=label, repetition=repetition, **measurement))
                    print(json.dumps(dict(case=name, binary=label, **measurement)), flush=True)
            medians = {label: statistics.median(run['wallMs'] for run in case['runs'] if run['binary'] == label)
                       for label in binaries}
            case['medianWallMs'] = medians
            case['speedup'] = medians['baseline'] / medians['candidate']
            case['capturedTreesEqual'] = True
            assert (sentinel / 'sentinel').read_bytes() == b'outside remains unchanged'
            proof['cases'].append(case)
        proof['outsideSentinelPreserved'] = True
    proof['ownedFixtureRemoved'] = not base.exists()
    args.output.write_text(json.dumps(proof, indent=2) + '\n')
    print(json.dumps({case['name']: dict(speedup=case['speedup'], medians=case['medianWallMs'])
                      for case in proof['cases']}), flush=True)


if __name__ == '__main__':
    main()
