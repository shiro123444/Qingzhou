#!/usr/bin/env python3
"""Measure a build's process tree and phases without recording its environment.

RSS sums can double-count shared pages. Sampling can miss short-lived peaks;
largest_child_maxrss_kib is a separate kernel high-water mark, not a tree sum.
"""
import argparse
import datetime
import json
import os
import pathlib
import re
import resource
import signal
import subprocess
import time


def process_tree(root_pid):
    records = {}
    for entry in pathlib.Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        try:
            stat = (entry / 'stat').read_text()
            tail = stat[stat.rfind(')') + 2:].split()
            records[int(entry.name)] = (int(tail[1]), int(tail[21]) * os.sysconf('SC_PAGE_SIZE'))
        except (OSError, ValueError, IndexError):
            pass
    members = {root_pid}
    while True:
        expanded = members | {pid for pid, (parent, _) in records.items() if parent in members}
        if expanded == members:
            break
        members = expanded
    rss = [records[pid][1] for pid in members if pid in records]
    return {'rss_bytes': sum(rss), 'largest_process_rss_bytes': max(rss, default=0), 'processes': len(rss)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cwd', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--interval', type=float, default=0.2)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    if not command or args.interval <= 0:
        parser.error('provide a command and a positive sample interval')
    output = pathlib.Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    log = output.with_suffix('.log')
    started = time.monotonic()
    started_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
    phase = 'startup'
    phases = {}
    patterns = [
        ('spa', re.compile(r'transforming\.\.\.|build:spa:raw|vite build')),
        ('next_compile', re.compile(r'Creating an optimized production build')),
        ('page_data', re.compile(r'Collecting page data')),
        ('prerender', re.compile(r'Generating static pages')),
        ('finalize', re.compile(r'Finalizing page optimization')),
    ]
    with log.open('wb') as writer, log.open('r', errors='replace') as reader:
        child = subprocess.Popen(command, cwd=args.cwd, stdout=writer, stderr=subprocess.STDOUT, start_new_session=True)
        def stop(signum, _frame):
            os.killpg(child.pid, signum)
        for signum in (signal.SIGINT, signal.SIGTERM):
            signal.signal(signum, stop)
        while child.poll() is None:
            for line in reader.readlines():
                for name, pattern in patterns:
                    if pattern.search(line):
                        phase = name
            sample = process_tree(child.pid)
            stats = phases.setdefault(phase, {'first_seen_seconds': time.monotonic() - started, 'samples': 0, 'peak_tree_rss_bytes': 0, 'peak_process_rss_bytes': 0, 'max_processes': 0})
            stats['samples'] += 1
            stats['peak_tree_rss_bytes'] = max(stats['peak_tree_rss_bytes'], sample['rss_bytes'])
            stats['peak_process_rss_bytes'] = max(stats['peak_process_rss_bytes'], sample['largest_process_rss_bytes'])
            stats['max_processes'] = max(stats['max_processes'], sample['processes'])
            time.sleep(args.interval)
    usage = resource.getrusage(resource.RUSAGE_CHILDREN)
    result = {
        'started_at_utc': started_at,
        'elapsed_seconds': time.monotonic() - started,
        'exit_code': child.returncode,
        'phases': phases,
        'peak_tree_rss_bytes': max((p['peak_tree_rss_bytes'] for p in phases.values()), default=0),
        'largest_child_maxrss_kib': usage.ru_maxrss,
        'child_cpu_seconds': usage.ru_utime + usage.ru_stime,
        'log': str(log),
        'notes': ['RSS sum can double-count shared pages; 200ms sampling can miss transient peaks.', 'Kernel maxrss is a single child high-water mark, not simultaneous tree usage.', 'No credentials or environment captured; phase markers come from build stdout.'],
    }
    output.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))
    return child.returncode if child.returncode >= 0 else 128 - child.returncode


if __name__ == '__main__':
    raise SystemExit(main())
