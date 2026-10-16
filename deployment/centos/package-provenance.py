#!/usr/bin/env python3
"""Reject foreign/stale Linux packages before executing their launchers."""
import hashlib
import json
import os
from pathlib import Path
import platform
import shlex
import sys


def host_identity(os_release=Path('/etc/os-release')):
    values = {}
    for line in os_release.read_text().splitlines():
        if '=' in line and not line.startswith('#'):
            key, value = line.split('=', 1)
            words = shlex.split(value)
            values[key] = words[0] if words else ''
    return {
        'id': values.get('ID'),
        'major': values.get('VERSION_ID', '').split('.')[0],
        'machine': platform.machine(),
        'libc': os.confstr('CS_GNU_LIBC_VERSION'),
    }


def archive_digest(archive):
    digest = hashlib.sha256()
    with archive.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def main():
    if len(sys.argv) != 3 or sys.argv[1] not in ('write', 'check'):
        raise SystemExit('Usage: package-provenance.py write|check PACKAGE.tgz')
    archive = Path(sys.argv[2])
    sidecar = Path(str(archive) + '.centos.json')
    host = host_identity()
    if host['id'] != 'centos' or host['major'] not in ('9', '10'):
        raise SystemExit('CentOS Stream 9/10 build provenance required.')
    expected = {'schemaVersion': 1, 'host': host, 'sha256': archive_digest(archive)}
    if sys.argv[1] == 'write':
        temporary = Path(str(sidecar) + '.partial')
        temporary.write_text(json.dumps(expected, indent=2) + '\n')
        temporary.replace(sidecar)
    else:
        if not sidecar.is_file() or json.loads(sidecar.read_text()) != expected:
            raise SystemExit('Missing/mismatched CentOS package provenance. Run deployment/centos/package.sh on this target; do not reuse an Ubuntu archive.')


if __name__ == '__main__':
    main()
