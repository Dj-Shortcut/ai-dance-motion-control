#!/usr/bin/env python3
"""Reject accidental credentials and runtime/private artifacts in tracked files.

This is a narrow local guard, not a full security audit. Matches are never
printed; CI reports only the path and category so a leak is not copied to logs.
"""
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
PATTERNS = {
    'Mollie key': re.compile(rb'\b(?:live|test)_[A-Za-z0-9]{30,}\b'),
    'Fal key': re.compile(rb'\b[0-9a-f]{8}-[0-9a-f-]{27}:[A-Za-z0-9_-]{20,}\b'),
    'GitHub token': re.compile(rb'\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b'),
    'Google client secret': re.compile(rb'\bGOCSPX-[A-Za-z0-9_-]{24,}\b'),
    'private key': re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),
}
PRIVATE_DIRS = {'.wrangler', 'node_modules', '.build', '__pycache__', '.rig-sites-build'}
MEDIA_EXTENSIONS = {'.mp4', '.mov', '.jpg', '.jpeg', '.wav', '.mp3'}


def main():
    paths = subprocess.check_output(['git', 'ls-files', '-z'], cwd=ROOT).decode().split('\0')
    findings = []
    for name in filter(None, paths):
        relative = Path(name)
        path = ROOT / relative
        if path.is_symlink():
            findings.append((name, 'tracked symlink'))
            continue
        if any(part in PRIVATE_DIRS or part.endswith('.app') for part in relative.parts):
            findings.append((name, 'runtime artifact'))
        if relative.name.startswith('.env') and relative.name != '.env.example':
            findings.append((name, 'environment file'))
        if relative.suffix.lower() in MEDIA_EXTENSIONS:
            findings.append((name, 'media must be generated from a synthetic fixture'))
        if not path.is_file():
            continue
        data = path.read_bytes()
        for category, pattern in PATTERNS.items():
            if pattern.search(data):
                findings.append((name, category))
    for name, category in findings:
        print(f'{name}: {category}', file=sys.stderr)
    if findings:
        return 1
    print('Tracked source guard passed; no matched credential or private runtime artifact.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
