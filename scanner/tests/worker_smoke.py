#!/usr/bin/env python3
"""Headless native protocol checks; every mutation stays in an owned temp fixture."""
import base64
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time

binary = str(Path(sys.argv[1]).resolve())

def launch(state, request):
    proc = subprocess.Popen([binary, '--worker', '--state-dir', str(state)],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    proc.stdin.write((json.dumps(request) + '\n').encode())
    proc.stdin.flush()
    return proc

def call(state, op, worker=None, **fields):
    req = dict(v=1, requestId='smoke', op=op, **fields)
    if worker is not None:
        req['expectedWorker'] = dict(id=worker['id'], account=worker['account'])
    proc = launch(state, req)
    lines, diagnostics = [], []
    def read(stream, destination):
        for line in stream:
            assert len(line) <= 4 * 1024 * 1024 + 1
            destination.append(line)
    readers = [threading.Thread(target=read, args=(proc.stdout, lines)),
               threading.Thread(target=read, args=(proc.stderr, diagnostics))]
    for thread in readers:
        thread.start()
    deadline = time.monotonic() + 30
    try:
        while proc.poll() is None:
            if time.monotonic() > deadline:
                raise AssertionError('native worker exceeded 30 seconds')
            try:
                proc.stdin.write(b'{"op":"ping","requestId":"smoke"}\n')
                proc.stdin.flush()
            except BrokenPipeError:
                pass
            time.sleep(0.02)
        for thread in readers:
            thread.join(3)
        records = [json.loads(line) for line in lines]
        assert records[0]['t'] == 'hello', records
        assert sum(row['t'] in ('result', 'done', 'fatal') for row in records) == 1, records
        assert records[-1]['t'] in ('result', 'done', 'fatal'), records
        assert not diagnostics, diagnostics
        return proc.returncode, records
    finally:
        if proc.poll() is None:
            proc.kill()
        proc.wait()
        for stream in (proc.stdin, proc.stdout, proc.stderr):
            stream.close()
        for thread in readers:
            thread.join(3)

with tempfile.TemporaryDirectory(prefix='disk-watch-protocol-test-') as fixture:
    fixture = Path(fixture).resolve()
    state, root, outside = [fixture / name for name in ('state', 'root', 'outside')]
    for path in (state, root, outside):
        path.mkdir(mode=0o700)
    (root / 'child').mkdir(mode=0o700)
    (root / 'child' / 'large').write_bytes(b'1234567')
    (root / 'small').write_bytes(b'x')
    (outside / 'sentinel').write_text('safe')
    (root / 'child' / 'link').symlink_to(outside, target_is_directory=True)
    raw = b'raw\xff\\\n' if sys.platform.startswith('linux') else 'unicode-é\\\n'.encode()
    raw_path = os.fsencode(root / 'child') + b'/' + raw
    descriptor = os.open(raw_path, os.O_CREAT | os.O_WRONLY | os.O_EXCL, 0o600)
    os.write(descriptor, b'abc')
    os.close(descriptor)
    code, records = call(state, 'hello')
    assert code == 0
    worker = records[-1]['value']
    assert worker['capabilities'] == {'scan': True, 'delete': True}
    code, records = call(state, 'inspect', worker, path=str(root))
    assert code == 0
    observed = records[-1]['value']
    assert observed['capacity']['total'] > 0
    code, records = call(state, 'scan', worker, root=observed, excludes=[], minFileSize=2)
    assert code == 0 and records[1]['t'] == 'root'
    assert records[-1]['coverage'] == 'complete' and records[-1]['size'] == 11
    assert records[-1]['policy'] == 'regular-files-single-mount-no-symlink-traversal'
    assert records[-1]['skipped'] == dict(symlinks=1, special=0, mounts=0)
    raw_records = [row for row in records if row.get('nameBytes') == base64.b64encode(raw).decode()]
    assert len(raw_records) == 1 and raw_records[0]['identity']['inode'].isdigit()
    assert all('createdAt' in row and 'lastWrittenAt' in row for row in records if row['t'] in ('dir', 'file'))
    parts = [base64.b64encode(part).decode() for part in (b'child', b'large')]
    code, records = call(state, 'resolve', worker, root=observed, components=parts)
    assert code == 0
    target = records[-1]['value']
    code, records = call(state, 'delete', worker, root=observed, operationId='smoke-delete', targets=[target])
    assert code != 0 and 'disabled' in records[-1]['message']
    code, records = call(state, 'cleanup', worker, root=observed, enabled=True)
    assert code == 0
    code, records = call(state, 'delete', worker, root=observed, operationId='smoke-delete', targets=[target])
    assert code == 0 and records[-1]['value']['state'] == 'completed'
    assert not (root / 'child' / 'large').exists()
    (root / 'child' / 'large').write_text('replacement')
    code, records = call(state, 'delete', worker, root=observed, operationId='smoke-delete', targets=[target])
    assert code == 0 and (root / 'child' / 'large').read_text() == 'replacement'
    code, records = call(state, 'deleteStatus', worker, operationId='smoke-delete')
    assert code == 0 and records[-1]['value']['deleted'] == [target['path']]
    code, records = call(state, 'inspect', dict(worker, id='wrong'), path=str(root))
    assert code != 0 and records[-1]['t'] == 'fatal'
    assert (outside / 'sentinel').read_text() == 'safe'
    # Enough output to block a worker whose controller has stopped reading.
    for n in range(3000):
        (root / 'child' / f'file-{n}').write_text('x')
    req = dict(v=1, requestId='drop', op='scan', root=observed, excludes=[], minFileSize=0,
               expectedWorker=dict(id=worker['id'], account=worker['account']))
    for mode in ('eof', 'cancel', 'timeout'):
        proc = launch(state, req)
        assert json.loads(proc.stdout.readline())['t'] == 'hello'
        started = time.monotonic()
        if mode == 'eof':
            proc.stdin.close()
        elif mode == 'cancel':
            proc.stdin.write(b'{"op":"cancel","requestId":"drop"}\n')
            proc.stdin.flush()
        try:
            proc.wait(timeout=25 if mode == 'timeout' else 5)
            assert proc.returncode != 0, mode
            assert time.monotonic() - started < (25 if mode == 'timeout' else 5)
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait()
            for stream in (proc.stdin, proc.stdout, proc.stderr):
                if not stream.closed:
                    stream.close()
    print('native protocol smoke passed: identity, scan bytes/times/totals, cleanup receipts, EOF/cancel/deadline')
