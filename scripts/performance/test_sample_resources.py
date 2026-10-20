"""Checks accounting boundaries, not application performance claims."""

import importlib.util
from pathlib import Path
import unittest


spec = importlib.util.spec_from_file_location('resource_sampler', Path(__file__).with_name('sample-resources.py'))
sampler = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sampler)


def process(pid, ppid=1, cwd='/srv/qingzhou', cgroup=None, start_ticks=10, cpu_ticks=0):
    return {'pid': pid, 'ppid': ppid, 'cwd': cwd, 'cgroup': cgroup,
            'start_ticks': start_ticks, 'cpu_ticks': cpu_ticks}


class ResourceAccountingTest(unittest.TestCase):
    def test_cpu_is_interval_delta_with_one_hundred_percent_per_core(self):
        before = {10: process(10, cpu_ticks=200), 11: process(11, cpu_ticks=800)}
        after = [process(10, cpu_ticks=350), process(11, cpu_ticks=850)]
        self.assertEqual(sampler.interval_cpu(after, before, 1, 100), 200)
        self.assertIsNone(sampler.interval_cpu(after, None, 1, 100))

    def test_pid_reuse_does_not_turn_a_lifetime_counter_into_interval_cpu(self):
        before = {10: process(10, start_ticks=10, cpu_ticks=800)}
        after = [process(10, start_ticks=20, cpu_ticks=900)]
        self.assertEqual(sampler.interval_cpu(after, before, 1, 100), 0)

    def test_container_takes_priority_over_matching_host_project_and_service_tree(self):
        item = process(10, cgroup='/system.slice/docker-abc.scope/child')
        containers = [{'name': 'postgres', 'cgroup': '/system.slice/docker-abc.scope'}]
        self.assertEqual(sampler.choose_group(item, {10: item}, {'web': '/srv/qingzhou'},
                                             {'web': (10, 10)}, containers), 'container:postgres')

    def test_cwd_boundary_and_descendant_inheritance(self):
        items = {10: process(10), 11: process(11, ppid=10, cwd='/tmp/job'),
                 12: process(12, cwd='/srv/qingzhou-backup')}
        self.assertEqual(sampler.choose_group(items[11], items, {'web': '/srv/qingzhou'}, {}, []), 'project:web')
        self.assertIsNone(sampler.choose_group(items[12], items, {'web': '/srv/qingzhou'}, {}, []))

    def test_nested_projects_choose_most_specific_and_exact_pid_tree_wins(self):
        item = process(10, cwd='/srv/qingzhou/docs/content')
        projects = {'web': '/srv/qingzhou', 'docs': '/srv/qingzhou/docs'}
        self.assertEqual(sampler.choose_group(item, {10: item}, projects, {}, []), 'project:docs')
        self.assertEqual(sampler.choose_group(item, {10: item}, projects, {'worker': (10, 10)}, []), 'pid:worker')

    def test_missing_pss_is_unknown_not_zero(self):
        self.assertIsNone(sampler.complete_sum([{'pss_kib': 25}, {'pss_kib': None}], 'pss_kib'))
        self.assertIsNone(sampler.complete_sum([], 'pss_kib'))
        self.assertEqual(sampler.complete_sum([{'pss_kib': 25}, {'pss_kib': 30}], 'pss_kib'), 55)

    def test_unusual_process_name_does_not_shift_stat_fields(self):
        fields = ['S'] + ['0'] * 21
        fields[1], fields[11], fields[12], fields[19], fields[21] = '7', '10', '20', '123', '8'
        record = sampler.parse_stat('42 (worker ) name) ' + ' '.join(fields))
        self.assertEqual((record['comm'], record['ppid'], record['cpu_ticks'], record['start_ticks']),
                         ('worker ) name', 7, 30, 123))
        self.assertEqual(record['rss_kib'], 8 * sampler.PAGE_KIB)

    def test_short_final_interval_is_weighted_when_reporting_cpu_mean(self):
        group = {'summed_rss_kib': 100, 'complete_pss_kib': 80, 'cgroup': None,
                 'processes': [{'pid': 10}]}
        samples = [{'interval_seconds': 1, 'groups': {'web': dict(group, cpu_percent=10)}},
                   {'interval_seconds': 0.1, 'groups': {'web': dict(group, cpu_percent=100)}}]
        summary = sampler.summarize(samples, ['web'])
        self.assertAlmostEqual(summary['web']['cpu_percent']['mean'], 20 / 1.1)


if __name__ == '__main__':
    unittest.main()
