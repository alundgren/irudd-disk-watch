#!/usr/bin/env python3
"""Linux cleanup fixtures for the real worker binary, run on a disposable Linux machine.

Usage: linux-delete-fixtures.py WORKER SCRATCH_DIR   (run fixtures)
       linux-delete-fixtures.py --cleanup SCRATCH_DIR (remove leftovers only)

Everything lives under SCRATCH_DIR: a loop-mounted ext4 image, its mount point, an outside
sentinel folder and a private worker state directory. sudo is used only to mount the image,
add mounts inside it, set chattr flags, and create the throwaway `dwtest` user and
`dwtestshare` group. The cleanup step undoes all of that, and runs even after failures.
"""
import base64
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import threading
import time

TEST_USER = 'dwtest'
TEST_GROUP = 'dwtestshare'


def sudo(*args, check=True):
    return subprocess.run(['sudo', '-n', *map(str, args)], check=check,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def mounts_under(path):
    prefix = os.fsencode(path)
    found = []
    with open('/proc/self/mountinfo', 'rb') as info:
        for line in info:
            point = line.split()[4].replace(b'\\040', b' ')
            if point == prefix or point.startswith(prefix + b'/'):
                found.append(point)
    return sorted(found, key=len, reverse=True)


SCRATCH_MARKER = '.dw-fixture-scratch'


def account_marker(scratch, name):
    return scratch / f'.created-{name}'


def cleanup(scratch):
    scratch = Path(scratch).resolve()
    if not (scratch / SCRATCH_MARKER).is_file():
        raise SystemExit(f'Refusing to clean {scratch}: it has no {SCRATCH_MARKER} marker')
    mnt = scratch / 'mnt'
    if mnt.is_dir() and mounts_under(mnt):
        # Writable again so immutable/append-only flags can be cleared before unmounting.
        sudo('mount', '-o', 'remount,rw', mnt, check=False)
        for nested in mounts_under(mnt):
            if nested != os.fsencode(mnt):
                sudo('umount', '-l', os.fsdecode(nested), check=False)
        sudo('chattr', '-R', '-i', '-a', mnt, check=False)
        sudo('umount', mnt, check=False)
    image = scratch / 'fixtures.img'
    if image.exists():
        for line in sudo('losetup', '-j', image, check=False).stdout.decode().splitlines():
            sudo('losetup', '-d', line.split(':')[0], check=False)
        image.unlink()
    if mnt.is_dir() and not mounts_under(mnt):
        mnt.rmdir()
    for path in (scratch / 'state', scratch / 'outside'):
        if path.exists():
            subprocess.run(['rm', '-rf', '--one-file-system', str(path)], check=False)
    # Only accounts this harness created (recorded by a marker) are removed.
    for name, remove in ((TEST_USER, 'userdel'), (TEST_GROUP, 'groupdel')):
        marker = account_marker(scratch, name)
        if marker.exists():
            if exists(name, remove == 'groupdel'):
                sudo(remove, name)
            marker.unlink()


def exists(name, group=False):
    command = ['getent', 'group' if group else 'passwd', name]
    return subprocess.run(command, capture_output=True).returncode == 0


class Worker:
    def __init__(self, binary, state):
        self.binary, self.state, self.worker, self.counter = binary, state, None, 0

    def call(self, op, **fields):
        self.counter += 1
        request = dict(v=1, requestId=f'fixture-{self.counter}', op=op, **fields)
        if self.worker is not None:
            request['expectedWorker'] = dict(id=self.worker['id'], account=self.worker['account'])
        proc = subprocess.Popen([self.binary, '--worker', '--state-dir', str(self.state)],
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        proc.stdin.write((json.dumps(request) + '\n').encode())
        proc.stdin.flush()
        lines = []
        reader = threading.Thread(target=lambda: lines.extend(proc.stdout))
        reader.start()
        deadline = time.monotonic() + 300
        while proc.poll() is None:
            if time.monotonic() > deadline:
                proc.kill()
                raise AssertionError(f'{op} exceeded 300 seconds')
            try:
                proc.stdin.write(f'{{"op":"ping","requestId":"{request["requestId"]}"}}\n'.encode())
                proc.stdin.flush()
            except BrokenPipeError:
                pass
            time.sleep(0.05)
        reader.join(5)
        for stream in (proc.stdin, proc.stdout, proc.stderr):
            stream.close()
        records = [json.loads(line) for line in lines]
        assert records and records[0]['t'] == 'hello', records
        if self.worker is None:
            self.worker = records[0]['worker']
        return proc.returncode, records

    def result(self, op, **fields):
        code, records = self.call(op, **fields)
        if code != 0:
            raise AssertionError(f'{op} failed: {records[-1]}')
        return records[-1]['value'] if records[-1]['t'] == 'result' else records


def b64(part):
    return base64.b64encode(os.fsencode(part) if isinstance(part, str) else part).decode()


class Run:
    def __init__(self, binary, scratch):
        self.scratch = Path(scratch).resolve()
        self.mnt = self.scratch / 'mnt'
        self.home = self.mnt / 'home'
        self.outside = self.scratch / 'outside'
        self.worker = Worker(binary, self.scratch / 'state')
        self.results = []
        self.ops = 0

    def setup(self):
        cleanup(self.scratch)
        for name, group in ((TEST_USER, False), (TEST_USER, True), (TEST_GROUP, True)):
            if exists(name, group):
                raise SystemExit(f'Refusing to start: {"group" if group else "user"} {name} already exists '
                                 'and was not created by this harness')
        image = self.scratch / 'fixtures.img'
        subprocess.run(['truncate', '-s', '512M', str(image)], check=True)
        subprocess.run(['/usr/sbin/mkfs.ext4', '-q', '-F', '-E', 'root_owner=0:0', str(image)], check=True)
        self.mnt.mkdir(mode=0o755)
        sudo('mount', '-o', 'loop', image, self.mnt)
        sudo('install', '-d', '-m', '755', '-o', os.getuid(), '-g', os.getgid(), self.home)
        self.outside.mkdir(mode=0o700)
        (self.outside / 'sentinel').write_text('safe')
        (self.scratch / 'state').mkdir(mode=0o700)
        sudo('useradd', '-M', '-r', '-s', '/usr/sbin/nologin', TEST_USER)
        account_marker(self.scratch, TEST_USER).touch()
        sudo('groupadd', TEST_GROUP)
        account_marker(self.scratch, TEST_GROUP).touch()
        sudo('usermod', '-aG', TEST_GROUP, TEST_USER)
        self.worker.result('hello')
        assert self.worker.worker['capabilities'].get('linuxPathTrust') is True, self.worker.worker
        self.root = self.worker.result('inspect', path=str(self.mnt))
        records = self.worker.result('scan', root=self.root, excludes=[], minFileSize=0)
        assert records[-1]['t'] == 'done', records[-1]
        self.worker.result('cleanup', root=self.root, enabled=True)

    def target(self, *parts):
        return self.worker.result('resolve', root=self.root, components=[b64(p) for p in parts])

    def delete(self, *targets):
        self.ops += 1
        return self.worker.call('delete', root=self.root, operationId=f'fixture-op-{self.ops}',
                                targets=list(targets))

    def record(self, name, expected, outcome, passed):
        self.results.append((name, expected, outcome, passed))
        print(f"{'PASS' if passed else 'FAIL'}  {name}: {outcome}", flush=True)

    def expect_deleted(self, name, expected, parts, extra=lambda: True):
        try:
            code, records = self.delete(self.target(*parts))
            receipt = records[-1].get('value', {})
            gone = not os.path.lexists(self.mnt.joinpath(*[os.fsdecode(p) for p in parts]))
            passed = code == 0 and receipt.get('failed') == [] and len(receipt.get('deleted', [])) == 1 and gone and extra()
            outcome = 'deleted' if passed else f'unexpected: code={code} {records[-1]}'
        except Exception as error:  # noqa: BLE001 - every fixture reports its own outcome
            passed, outcome = False, f'error: {error}'
        self.record(name, expected, outcome, passed)

    def expect_failed(self, name, expected, parts, text, survivor, extra=lambda: True):
        try:
            code, records = self.delete(self.target(*parts))
            receipt = records[-1].get('value', {})
            failed = receipt.get('failed') or []
            message = failed[0]['message'] if failed else records[-1].get('message', '')
            passed = (code == 0 and len(failed) == 1 and receipt.get('deleted') == []
                      and text in message and os.path.lexists(survivor) and extra())
            outcome = f'refused: {message}' if passed else f'unexpected: code={code} {records[-1]}'
        except Exception as error:  # noqa: BLE001
            passed, outcome = False, f'error: {error}'
        self.record(name, expected, outcome, passed)

    def fixture(self, name):
        path = self.home / name
        path.mkdir()
        return path

    def run(self):
        sentinel = lambda: (self.outside / 'sentinel').read_text() == 'safe'

        f = self.fixture('symlinks')
        (f / 't').mkdir()
        (f / 'keep').mkdir()
        (f / 'keep' / 'inside').write_text('safe')
        os.symlink(self.outside / 'sentinel', f / 't' / 'to-outside-file')
        os.symlink(self.outside, f / 't' / 'to-outside-dir')
        os.symlink(f / 'keep', f / 't' / 'to-sibling-dir')
        self.expect_deleted('symlink to outside file and folder', 'links removed, targets survive',
                            ['home', 'symlinks', 't'],
                            lambda: sentinel() and (f / 'keep' / 'inside').read_text() == 'safe')

        f = self.fixture('dangling')
        (f / 't').mkdir()
        os.symlink('/nonexistent/dw-fixture', f / 't' / 'dangling')
        self.expect_deleted('dangling symlink', 'deleted', ['home', 'dangling', 't'])

        f = self.fixture('loop')
        (f / 't').mkdir()
        os.symlink('b', f / 't' / 'a')
        os.symlink('a', f / 't' / 'b')
        self.expect_deleted('symlink loop', 'deleted', ['home', 'loop', 't'])

        self.swap_race()

        f = self.fixture('robind')
        (f / 'src').mkdir()
        (f / 'src' / 'data').write_text('bound')
        (f / 't' / 'bind').mkdir(parents=True)
        (f / 't' / 'plain').write_text('x')
        sudo('mount', '--bind', f / 'src', f / 't' / 'bind')
        sudo('mount', '-o', 'remount,bind,ro', f / 't' / 'bind')
        self.expect_failed('read-only bind mount inside tree', 'stops at the mount', ['home', 'robind', 't'],
                           'mount', f / 't' / 'bind' / 'data',
                           lambda: (f / 'src' / 'data').read_text() == 'bound')
        sudo('umount', f / 't' / 'bind')

        f = self.fixture('tmpfs')
        (f / 't' / 'tmp').mkdir(parents=True)
        sudo('mount', '-t', 'tmpfs', '-o', f'size=1m,uid={os.getuid()},gid={os.getgid()},mode=700',
             'dwtest-tmpfs', f / 't' / 'tmp')
        (f / 't' / 'tmp' / 'data').write_text('tmpfs')
        self.expect_failed('tmpfs mount inside tree', 'stops at the mount', ['home', 'tmpfs', 't'],
                           'different filesystem', f / 't' / 'tmp' / 'data')
        sudo('umount', f / 't' / 'tmp')

        f = self.fixture('immutable')
        (f / 't').mkdir()
        (f / 't' / 'locked').write_text('immutable')
        sudo('chattr', '+i', f / 't' / 'locked')
        self.expect_failed('chattr +i file', 'EPERM reported, file kept', ['home', 'immutable', 't'],
                           'immutable or append-only', f / 't' / 'locked')
        sudo('chattr', '-i', f / 't' / 'locked')

        f = self.fixture('appendonly')
        (f / 't' / 'log').mkdir(parents=True)
        (f / 't' / 'log' / 'entry').write_text('append')
        sudo('chattr', '+a', f / 't' / 'log')
        self.expect_failed('chattr +a folder', 'EPERM reported, content kept', ['home', 'appendonly', 't'],
                           'immutable or append-only', f / 't' / 'log' / 'entry')
        sudo('chattr', '-a', f / 't' / 'log')

        f = self.fixture('theirdir')
        (f / 't').mkdir()
        sudo('install', '-d', '-m', '755', '-o', TEST_USER, '-g', TEST_USER, f / 't' / 'theirs')
        sudo('install', '-m', '644', '-o', TEST_USER, '-g', TEST_USER, '/dev/null', f / 't' / 'theirs' / 'file')
        self.expect_failed("other user's folder in a 0755 tree", 'refused, owned by another user',
                           ['home', 'theirdir', 't'], 'owned by another user', f / 't' / 'theirs' / 'file')

        f = self.fixture('theirfile')
        (f / 't').mkdir()
        sudo('install', '-m', '644', '-o', TEST_USER, '-g', TEST_USER, '/dev/null', f / 't' / 'file')
        self.expect_deleted("other user's file in our 0755 folder", 'deleted (folder owner may unlink)',
                            ['home', 'theirfile', 't'])

        f = self.fixture('oursticky')
        (f / 't').mkdir()
        os.chmod(f / 't', 0o1777)
        sudo('install', '-m', '644', '-o', TEST_USER, '-g', TEST_USER, '/dev/null', f / 't' / 'file')
        self.expect_deleted("other user's file in our sticky 1777 folder", 'deleted (sticky folder owner may unlink)',
                            ['home', 'oursticky', 't'])

        f = self.fixture('rootsticky')
        sudo('install', '-d', '-m', '1777', '-o', 'root', '-g', 'root', f / 'shared')
        (f / 'shared' / 'mine').mkdir()
        (f / 'shared' / 'mine' / 'file').write_text('x')
        sudo('install', '-m', '644', '-o', TEST_USER, '-g', TEST_USER, '/dev/null', f / 'shared' / 'theirs')
        self.expect_deleted('our folder inside a root-owned sticky 1777 ancestor (like /tmp)', 'deleted',
                            ['home', 'rootsticky', 'shared', 'mine'])
        try:
            code, records = self.delete(self.target('home', 'rootsticky', 'shared', 'theirs'))
            failed = records[-1].get('value', {}).get('failed') or []
            ok = code == 0 and len(failed) == 1 and 'Not permitted' in failed[0]['message'] and (f / 'shared' / 'theirs').exists()
            self.record("other user's file directly in a root-owned sticky folder", 'EPERM reported',
                        f"refused: {failed[0]['message']}" if ok else f'unexpected: {records[-1]}', ok)
        except Exception as error:  # noqa: BLE001
            self.record("other user's file directly in a root-owned sticky folder", 'EPERM reported', f'error: {error}', False)

        f = self.fixture('privategroup')
        (f / 't' / 'a' / 'b').mkdir(parents=True)
        (f / 't' / 'a' / 'b' / 'file').write_text('x')
        for path in (f, f / 't', f / 't' / 'a', f / 't' / 'a' / 'b'):
            os.chmod(path, 0o775)
        self.expect_deleted('group-writable folders with our private group', 'deleted',
                            ['home', 'privategroup', 't'])

        f = self.fixture('sharedgroup')
        (f / 'shared' / 't').mkdir(parents=True)
        (f / 'shared' / 't' / 'file').write_text('x')
        sudo('chgrp', TEST_GROUP, f / 'shared')
        os.chmod(f / 'shared', 0o775)
        self.expect_failed('group-writable ancestor whose group has another member', 'refused',
                           ['home', 'sharedgroup', 'shared', 't'], 'writable by a group', f / 'shared' / 't' / 'file')
        self.expect_failed('group-writable shared-group folder as the target', 'refused',
                           ['home', 'sharedgroup', 'shared'], 'writable by a group', f / 'shared' / 't' / 'file')

        f = self.fixture('acl')
        (f / 'guarded' / 't').mkdir(parents=True)
        (f / 'guarded' / 't' / 'file').write_text('x')
        uid = int(subprocess.run(['id', '-u', TEST_USER], capture_output=True, check=True).stdout)
        entries = [(0x01, 7, 0xFFFFFFFF), (0x02, 7, uid), (0x04, 5, 0xFFFFFFFF), (0x10, 7, 0xFFFFFFFF),
                   (0x20, 5, 0xFFFFFFFF)]
        value = (2).to_bytes(4, 'little') + b''.join(
            tag.to_bytes(2, 'little') + perm.to_bytes(2, 'little') + ident.to_bytes(4, 'little')
            for tag, perm, ident in entries)
        os.setxattr(f / 'guarded', 'system.posix_acl_access', value)
        self.expect_failed('POSIX ACL user entry on an ancestor', 'refused', ['home', 'acl', 'guarded', 't'],
                           'POSIX ACL', f / 'guarded' / 't' / 'file')

        f = self.fixture('special')
        (f / 't').mkdir()
        os.mkfifo(f / 't' / 'fifo')
        cwd = os.getcwd()
        os.chdir(f / 't')
        try:
            with socket.socket(socket.AF_UNIX) as listener:
                listener.bind('socket')
        finally:
            os.chdir(cwd)
        self.expect_deleted('fifo and socket inside tree', 'deleted', ['home', 'special', 't'])

        f = self.fixture('hardlink')
        (f / 't').mkdir()
        (f / 'keep').write_text('linked')
        os.link(f / 'keep', f / 't' / 'other-name')
        self.expect_deleted('hard link inside tree', 'link removed, other name survives', ['home', 'hardlink', 't'],
                            lambda: (f / 'keep').read_text() == 'linked')

        f = self.fixture('names')
        odd = b'n\xffl\nx'
        os.mkdir(os.fsencode(f) + b'/' + odd)
        os.mkdir(os.fsencode(f) + b'/' + odd + b'/' + b'sub\xfe\n')
        with open(os.fsencode(f) + b'/' + odd + b'/' + b'sub\xfe\n/file\n\xff', 'w') as out:
            out.write('x')
        self.expect_deleted('non-UTF-8 and newline names', 'deleted', [b'home', b'names', odd])

        f = self.fixture('locked')
        (f / 't' / 'closed').mkdir(parents=True)
        (f / 't' / 'closed' / 'file').write_text('x')
        os.chmod(f / 't' / 'closed', 0)
        self.expect_failed('0000 folder we own', 'EACCES reported, not chmodded', ['home', 'locked', 't'],
                           'Permission denied', f / 't' / 'closed',
                           lambda: (os.stat(f / 't' / 'closed').st_mode & 0o7777) == 0)
        os.chmod(f / 't' / 'closed', 0o700)

        f = self.fixture('readonlydir')
        (f / 't' / 'r').mkdir(parents=True)
        (f / 't' / 'r' / 'file').write_text('x')
        os.chmod(f / 't' / 'r', 0o500)
        self.expect_failed('0500 folder we own', 'EACCES reported, not chmodded', ['home', 'readonlydir', 't'],
                           'Permission denied', f / 't' / 'r' / 'file')
        os.chmod(f / 't' / 'r', 0o700)

        f = self.fixture('deep')
        path = os.fsencode(f / 't')
        os.mkdir(path)
        for _ in range(300):
            path += b'/d'
            os.mkdir(path)
        with open(path + b'/leaf', 'w') as out:
            out.write('x')
        self.expect_deleted('300 nested folders', 'deleted', ['home', 'deep', 't'])

        try:
            code, records = self.delete(self.target('home'))
            ok = code != 0 and 'immediate children' in records[-1].get('message', '') and self.home.exists()
            self.record('depth-1 target under the image mount root', 'refused',
                        f"refused: {records[-1].get('message')}" if ok else f'unexpected: {records[-1]}', ok)
        except Exception as error:  # noqa: BLE001
            self.record('depth-1 target under the image mount root', 'refused', f'error: {error}', False)

        f = self.fixture('remountro')
        (f / 't').mkdir()
        (f / 't' / 'file').write_text('x')
        target = self.target('home', 'remountro', 't')
        sudo('mount', '-o', 'remount,ro', self.mnt)
        try:
            code, records = self.delete(target)
            ok = code != 0 and 'read-only' in records[-1].get('message', '') and (f / 't' / 'file').exists()
            self.record('whole image remounted read-only', 'refused before any change',
                        f"refused: {records[-1].get('message')}" if ok else f'unexpected: {records[-1]}', ok)
        finally:
            sudo('mount', '-o', 'remount,rw', self.mnt)

    def swap_race(self):
        """Replace folders with symlinks to the outside sentinel while a delete runs."""
        f = self.fixture('swap')
        (f / 't').mkdir()
        for n in range(200):
            d = f / 't' / f'd{n:03}'
            d.mkdir()
            for m in range(20):
                (d / f'f{m}').write_text('x')
        target = self.target('home', 'swap', 't')
        stop = threading.Event()
        swaps = [0]

        def swapper():
            n = 199
            while not stop.is_set() and n >= 0:
                d = f / 't' / f'd{n:03}'
                try:
                    os.rename(d, f / f'moved{n:03}')
                    os.symlink(self.outside, d)
                    swaps[0] += 1
                except OSError:
                    pass
                n -= 1
        thread = threading.Thread(target=swapper)
        thread.start()
        try:
            code, records = self.delete(target)
        finally:
            stop.set()
            thread.join()
        receipt = records[-1].get('value', {})
        intact = (self.outside / 'sentinel').read_text() == 'safe'
        ok = code == 0 and intact and receipt.get('state') == 'completed'
        detail = ('deleted before any swap landed' if receipt.get('failed') == [] else
                  f"stopped: {receipt['failed'][0]['message']}" if receipt.get('failed') else str(records[-1]))
        self.record('folder swapped for a symlink mid-delete', 'outside target survives',
                    f'{detail}; {swaps[0]} swaps; outside sentinel intact={intact}', ok)


def main():
    if sys.argv[1] == '--cleanup':
        cleanup(sys.argv[2])
        return 0
    run = Run(str(Path(sys.argv[1]).resolve()), sys.argv[2])
    try:
        run.setup()
        run.run()
    finally:
        cleanup(run.scratch)
    failed = [row for row in run.results if not row[3]]
    print(f'\n{len(run.results) - len(failed)} of {len(run.results)} fixtures behaved as intended')
    print('\n| Fixture | Expected | Outcome |\n| --- | --- | --- |')
    for name, expected, outcome, passed in run.results:
        print(f"| {name} | {expected} | {'' if passed else 'FAIL: '}{outcome.replace('|', '/')} |")
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
