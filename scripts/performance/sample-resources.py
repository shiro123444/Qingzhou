#!/usr/bin/env python3
"""Read-only Linux process/cgroup sampler; Python standard library only.

Example (run on the deployment host, not in an isolated agent/container):
  python3 scripts/performance/sample-resources.py \
    --project qingzhou=/srv/qingzhou --container qingzhou-postgres \
    --duration 15 --output /tmp/qingzhou-resources.json

No command lines, environment variables, Docker environment or logs are read.
CWD selection includes development tools: use --pid for exact service trees,
or explicitly exclude verified tooling PIDs. Exclusions affect only that PID
or executable name, never its children (which could be application services).
"""

import argparse
import datetime
import json
import os
from pathlib import Path
import re
import statistics
import subprocess
import time


PROC = Path('/proc')
CGROUP = Path('/sys/fs/cgroup')
PAGE_KIB = os.sysconf('SC_PAGE_SIZE') // 1024
TICKS_PER_SECOND = os.sysconf('SC_CLK_TCK')


def read_text(path):
    try:
        return Path(path).read_text()
    except (OSError, UnicodeError):
        return None


def read_link(path):
    try:
        return os.readlink(path)
    except OSError:
        return None


def key_values(text):
    result = {}
    for line in (text or '').splitlines():
        fields = line.replace(':', ' ').split()
        if len(fields) >= 2:
            try:
                result[fields[0]] = int(fields[1])
            except ValueError:
                pass
    return result


def parse_stat(text):
    # comm may contain spaces or closing parentheses; fields start after its last ).
    closing = text.rindex(')')
    fields = text[closing + 2:].split()
    return {
        'comm': text[text.index('(') + 1:closing],
        'ppid': int(fields[1]),
        'cpu_ticks': int(fields[11]) + int(fields[12]),
        'start_ticks': int(fields[19]),
        'rss_kib': int(fields[21]) * PAGE_KIB,
    }


def cgroup_path(text):
    for line in (text or '').splitlines():
        if line.startswith('0::/'):
            value = line[3:]
            if '..' not in Path(value).parts:
                return value
    return None


def is_inside(path, root):
    return path == root or (path is not None and path.startswith(root.rstrip('/') + '/'))


def scan_processes():
    processes = {}
    visible = unreadable_stat = unreadable_cwd = 0
    for entry in PROC.iterdir():
        if not entry.name.isdigit():
            continue
        visible += 1
        raw = read_text(entry / 'stat')
        try:
            process = parse_stat(raw or '')
        except (ValueError, IndexError):
            unreadable_stat += 1
            continue
        process['pid'] = int(entry.name)
        process['cwd'] = read_link(entry / 'cwd')
        unreadable_cwd += process['cwd'] is None
        process['cgroup'] = cgroup_path(read_text(entry / 'cgroup'))
        processes[process['pid']] = process
    return processes, {
        'visible_pids': visible,
        'unreadable_stat_pids': unreadable_stat,
        'unreadable_cwd_pids': unreadable_cwd,
    }


def lineage(pid, processes):
    seen = set()
    while pid in processes and pid not in seen:
        seen.add(pid)
        yield processes[pid]
        pid = processes[pid]['ppid']


def choose_group(process, processes, projects, roots, containers):
    # A container owns its PIDs before any host cwd/PID-tree attribution.
    for container in containers:
        if container.get('cgroup') and is_inside(process['cgroup'], container['cgroup']):
            return 'container:' + container['name']
    ancestors = list(lineage(process['pid'], processes))
    for ancestor in ancestors:
        for name, identity in roots.items():
            if (ancestor['pid'], ancestor['start_ticks']) == identity:
                return 'pid:' + name
    for ancestor in ancestors:
        matches = [(len(root), name) for name, root in projects.items()
                   if is_inside(ancestor['cwd'], root)]
        if matches:
            return 'project:' + max(matches)[1]
    return None


def process_memory(process):
    pid = process['pid']
    rollup = key_values(read_text(PROC / str(pid) / 'smaps_rollup'))
    status = key_values(read_text(PROC / str(pid) / 'status'))
    return {
        'pid': pid,
        'ppid': process['ppid'],
        'comm': process['comm'],
        'start_ticks': process['start_ticks'],
        'rss_kib': process['rss_kib'],
        'pss_kib': rollup.get('Pss'),
        'swap_pss_kib': rollup.get('SwapPss'),
        'vm_swap_kib': status.get('VmSwap'),
    }


def read_number(path):
    value = read_text(path)
    try:
        return int(value) if value is not None else None
    except ValueError:
        return None  # cgroup's "max" is unbounded, not zero.


def read_cgroup(path):
    if not path:
        return None
    root = CGROUP / path.lstrip('/')
    memory = read_number(root / 'memory.current')
    cpu = key_values(read_text(root / 'cpu.stat'))
    if memory is None and 'usage_usec' not in cpu:
        return None
    return {
        'path': path,
        'memory_current_bytes': memory,
        'memory_max_bytes': read_number(root / 'memory.max'),
        'memory_swap_current_bytes': read_number(root / 'memory.swap.current'),
        'memory_swap_max_bytes': read_number(root / 'memory.swap.max'),
        'memory_events': key_values(read_text(root / 'memory.events')),
        'cpu_usage_usec': cpu.get('usage_usec'),
        'cpu_throttled_usec': cpu.get('throttled_usec'),
        'cpu_max': (read_text(root / 'cpu.max') or '').strip() or None,
        'cpu_pressure': (read_text(root / 'cpu.pressure') or '').strip() or None,
        'memory_pressure': (read_text(root / 'memory.pressure') or '').strip() or None,
    }


def discover_container(name):
    # Explicit fields prevent accidentally collecting Config.Env or command args.
    fmt = ('{"id":{{json .Id}},"name":{{json .Name}},'
           '"running":{{json .State.Running}},"pid":{{json .State.Pid}},'
           '"configured_memory_bytes":{{json .HostConfig.Memory}},'
           '"configured_nano_cpus":{{json .HostConfig.NanoCpus}}}')
    try:
        result = subprocess.run(
            ['docker', 'inspect', '--type', 'container', '--format', fmt, name],
            capture_output=True, text=True, timeout=10, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return {'name': name, 'available': False, 'reason': 'docker_inspect_unavailable'}
    if result.returncode:
        return {'name': name, 'available': False, 'reason': 'docker_inspect_failed'}
    try:
        record = json.loads(result.stdout)
    except (ValueError, TypeError):
        return {'name': name, 'available': False, 'reason': 'invalid_docker_inspect_output'}
    record['name'] = name
    record['cgroup'] = cgroup_path(read_text(PROC / str(record['pid']) / 'cgroup'))
    # A remote daemon's PID may coincide with a local process. Verify the full ID.
    local = record['cgroup'] and record['id'] in record['cgroup']
    record['available'] = bool(record['running'] and local)
    if not record['available']:
        record['cgroup'] = None
        record['reason'] = 'stopped_or_not_visible_in_local_cgroup_v2'
    return record


def interval_cpu(current, previous, seconds, ticks_per_second=TICKS_PER_SECOND):
    if previous is None or seconds <= 0:
        return None
    ticks = 0
    for process in current:
        old = previous.get(process['pid'])
        if old and old['start_ticks'] == process['start_ticks']:
            ticks += max(0, process['cpu_ticks'] - old['cpu_ticks'])
    return 100 * ticks / ticks_per_second / seconds


def complete_sum(records, key):
    values = [record[key] for record in records]
    return sum(values) if values and all(value is not None for value in values) else None


def summarize(samples, group_names):
    result = {}
    for name in group_names:
        metrics = {}
        for metric in ('summed_rss_kib', 'complete_pss_kib', 'cpu_percent',
                       'cgroup_memory_current_bytes', 'cgroup_memory_swap_current_bytes'):
            values = []
            weights = []
            for sample in samples:
                group = sample['groups'][name]
                value = (group['cgroup'] or {}).get(metric.removeprefix('cgroup_')) \
                    if metric.startswith('cgroup_') else group.get(metric)
                if value is not None:
                    values.append(value)
                    weights.append(sample.get('interval_seconds') or 0)
            mean = (sum(value * weight for value, weight in zip(values, weights)) / sum(weights)
                    if metric == 'cpu_percent' and sum(weights) else statistics.fmean(values)) if values else None
            metrics[metric] = {'min': min(values), 'mean': mean,
                               'max': max(values), 'observations': len(values)} if values else None
        metrics['max_process_count'] = max(len(sample['groups'][name]['processes']) for sample in samples)
        result[name] = metrics
    return result


def named_value(value):
    name, separator, target = value.partition('=')
    if not separator or not re.fullmatch(r'[A-Za-z0-9_.-]+', name) or not target:
        raise argparse.ArgumentTypeError('expected NAME=VALUE, with a simple group name')
    return name, target


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--project', type=named_value, action='append', default=[], metavar='NAME=PATH')
    parser.add_argument('--pid', type=named_value, action='append', default=[], metavar='NAME=PID')
    parser.add_argument('--container', action='append', default=[], metavar='NAME')
    parser.add_argument('--exclude-pid', type=int, action='append', default=[])
    parser.add_argument('--exclude-comm', action='append', default=[])
    parser.add_argument('--duration', type=float, default=15)
    parser.add_argument('--interval', type=float, default=1)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    if not (0 < args.interval <= args.duration <= 3600):
        parser.error('require 0 < interval <= duration <= 3600 seconds')
    if not (args.project or args.pid or args.container):
        parser.error('select at least one project, service PID tree, or container')
    if len(dict(args.project)) != len(args.project) or len(dict(args.pid)) != len(args.pid):
        parser.error('group names must be unique within each selection kind')
    projects = {name: str(Path(root).resolve()) for name, root in args.project}
    if any(not Path(root).is_dir() for root in projects.values()):
        parser.error('project paths must be existing directories')
    containers = [discover_container(name) for name in args.container]
    ids = [item['id'] for item in containers if item.get('id')]
    if len(set(ids)) != len(ids):
        parser.error('the same container was selected more than once')
    initial, _ = scan_processes()
    roots = {}
    for name, value in args.pid:
        try:
            pid = int(value)
            roots[name] = (pid, initial[pid]['start_ticks'])
        except (ValueError, KeyError):
            parser.error('selected service PID must exist and have readable /proc stat')
    # Exclude sampling overhead, not all children of the shell/agent launching it.
    sampler_ancestors = {item['pid'] for item in lineage(os.getpid(), initial)}
    excluded_pids = sampler_ancestors | set(args.exclude_pid)
    excluded_comms = set(args.exclude_comm)
    names = (['project:' + name for name in projects] + ['pid:' + name for name in roots]
             + ['container:' + item['name'] for item in containers])
    selected_containers = {'container:' + item['name']: item for item in containers}
    warnings = [
        'CWD groups can contain development tools; selection does not prove a web service is running.',
        'RSS sums count shared pages repeatedly. PSS is complete only when every selected PID is readable.',
        'Never add a container cgroup value to its process RSS/PSS; they describe the same group.',
        'Process CPU excludes unobserved/first-seen/exited processes; cgroup CPU includes short-lived children.',
        'Sampled peaks can miss sub-interval bursts. No workload or startup was triggered by this sampler.',
        'Cgroup limits are local limits; an ancestor cgroup may impose a stricter effective limit.',
    ]
    warnings += [item['name'] + ': ' + item['reason'] for item in containers if not item['available']]
    record = {
        'schema_version': 1,
        'started_at_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'requested_duration_seconds': args.duration,
        'requested_interval_seconds': args.interval,
        'cpu_percent_definition': '100 percent = one logical CPU fully occupied during the measured interval',
        'host': {
            'logical_cpus': os.cpu_count(),
            'kernel': os.uname().release,
            'pid1_comm': (read_text(PROC / '1/comm') or '').strip() or None,
            'self_pid_namespace': read_link(PROC / 'self/ns/pid'),
            'pid1_namespace': read_link(PROC / '1/ns/pid'),
            'sampler_cgroup': cgroup_path(read_text(PROC / 'self/cgroup')),
        },
        'selection': {'projects': projects, 'service_roots': roots, 'containers': containers,
                      'exclude_pids': sorted(excluded_pids), 'exclude_comms': sorted(excluded_comms)},
        'warnings': warnings,
        'samples': [],
    }
    start = time.monotonic()
    previous_processes = previous_sample = None
    while True:
        processes, visibility = scan_processes()
        now = time.monotonic()
        elapsed = now - start
        interval = now - previous_sample['_monotonic'] if previous_sample else None
        grouped = {name: [] for name in names}
        excluded = []
        for process in processes.values():
            group = choose_group(process, processes, projects, roots, containers)
            if not group:
                continue
            if process['pid'] in excluded_pids or process['comm'] in excluded_comms:
                excluded.append({'pid': process['pid'], 'comm': process['comm'], 'group': group})
            else:
                grouped[group].append(process)
        groups = {}
        for name, members in grouped.items():
            members.sort(key=lambda item: item['pid'])
            memory = [process_memory(item) for item in members]
            container = selected_containers.get(name)
            cgroup = read_cgroup(container['cgroup']) if container and container.get('cgroup') else None
            cpu = interval_cpu(members, previous_processes, interval or 0)
            cpu_source = 'process_ticks_lower_bound'
            if container:
                cpu_source = 'cgroup_usage_usec'
                old = previous_sample['groups'][name]['cgroup'] if previous_sample else None
                current_usage = (cgroup or {}).get('cpu_usage_usec')
                old_usage = (old or {}).get('cpu_usage_usec')
                cpu = (100 * (current_usage - old_usage) / 1_000_000 / interval
                       if current_usage is not None and old_usage is not None
                       and current_usage >= old_usage and interval else None)
            groups[name] = {
                'state': 'observed' if members or cgroup else
                         ('unavailable' if container else 'no_matching_processes'),
                'processes': memory,
                'summed_rss_kib': sum(item['rss_kib'] for item in memory) if memory else None,
                'complete_pss_kib': complete_sum(memory, 'pss_kib'),
                'pss_readable_pids': sum(item['pss_kib'] is not None for item in memory),
                'complete_vm_swap_kib': complete_sum(memory, 'vm_swap_kib'),
                'cpu_percent': cpu if members or cgroup else None,
                'cpu_source': cpu_source,
                'cgroup': cgroup,
            }
        meminfo = key_values(read_text(PROC / 'meminfo'))
        sample = {
            'elapsed_seconds': elapsed,
            'interval_seconds': interval,
            'host_memory_kib': {key: meminfo.get(key) for key in
                                ('MemTotal', 'MemAvailable', 'SwapTotal', 'SwapFree')},
            'visibility': visibility,
            'groups': groups,
            'excluded_project_processes': excluded,
        }
        record['samples'].append(sample)
        previous_processes = processes
        previous_sample = dict(sample, _monotonic=now)
        if elapsed >= args.duration:
            break
        # Include a final sample at the deadline, without sleeping a full extra interval.
        time.sleep(max(0, min(start + args.duration, now + args.interval) - time.monotonic()))
    record['ended_at_utc'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    record['sampled_duration_seconds'] = record['samples'][-1]['elapsed_seconds'] - record['samples'][0]['elapsed_seconds']
    record['summary'] = summarize(record['samples'], names)
    result = json.dumps(record, indent=2, ensure_ascii=False) + '\n'
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(result)
        print(json.dumps({'output': str(args.output), 'sampled_duration_seconds': record['sampled_duration_seconds'],
                          'summary': record['summary'], 'warnings': warnings}, indent=2, ensure_ascii=False))
    else:
        print(result, end='')


if __name__ == '__main__':
    main()
