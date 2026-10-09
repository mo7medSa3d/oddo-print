"""F020/O8: unchanged cron_sync_status function with simulated Odoo ORM + SQLite SQL.

No real PostgreSQL/Odoo cron/Gateway installation acceptance is implied.
"""
import datetime
import sqlite3
from types import SimpleNamespace
from unittest.mock import Mock

from test_f010_report_binding_identity import production_methods

CronProduction = production_methods('print_job.py', ['cron_sync_status'])


def test_real_cron_eventually_polls_101st_unresolved_job_after_bounded_page():
    db = sqlite3.connect(':memory:')
    db.create_function('now', 0, lambda: '2026-10-09 10:00:00')
    db.execute('''CREATE TABLE print_gateway_print_job (
        id INTEGER PRIMARY KEY, gateway_job_id TEXT, status TEXT,
        last_error TEXT, next_retry_at TEXT, last_status_polled_at TEXT
    )''')
    db.executemany('INSERT INTO print_gateway_print_job (id,gateway_job_id,status) VALUES (?,?,?)',
                   [(i, f'gw-{i}', 'claimed') for i in range(1, 102)])
    db.commit()

    class Cursor:
        def __init__(self): self.result = None
        def execute(self, query, params=()):
            self.result = db.execute(query.replace('%%', '%'), params)
        def fetchall(self): return self.result.fetchall()
        def savepoint(self):
            from contextlib import nullcontext
            return nullcontext()

    cr = Cursor()
    class Config:
        id = 1
        def sudo(self): return self
        def _gateway_base(self, **_kwargs): return 'https://mock-gateway.invalid'
        def _gateway_headers(self): return {}
    config = Config()
    job_records = {}
    for i in range(1, 102):
        job_records[i] = SimpleNamespace(id=i, gateway_job_id=f'gw-{i}',
                                         gateway_config_id=config)

    class JobSet:
        def __init__(self, jobs=()): self.jobs = list(jobs)
        def __iter__(self): return iter(self.jobs)
        def __ior__(self, job):
            self.jobs.append(job)
            return self
        def sudo(self): return self
        def browse(self, ids): return JobSet(job_records[i] for i in ids)
        def write(self, values):
            assert list(values) == ['last_status_polled_at']
            stamp = str(values['last_status_polled_at'])
            db.executemany('UPDATE print_gateway_print_job SET last_status_polled_at = ? WHERE id = ?',
                           [(stamp, job.id) for job in self.jobs])

    class Cron:
        def _commit_progress(self, processed):
            db.commit()
            return 100000

    class Environment:
        def __init__(self): self.cr = cr
        def __getitem__(self, name):
            assert name in ('print_gateway.print_job', 'ir.cron')
            return JobSet() if name == 'print_gateway.print_job' else Cron()

    seen = []
    def post(_url, *, json, **_kwargs):
        seen.append([int(i.removeprefix('gw-')) for i in json['jobIds']])
        return SimpleNamespace(status_code=200,
            json=lambda: {'jobs': [{'jobId': i, 'status': 'claimed'} for i in json['jobIds']]})

    class Router(CronProduction):
        env = Environment()
        def _require_cron_runner(self): return True
        def browse(self, ids): return JobSet(job_records[i] for i in ids)
        def sudo(self): return JobSet()
        def _apply_synced_status(self, _job, _status): return False
        def _mark_gateway_job_missing(self, *_args): raise AssertionError('Unexpected remote job missing')

    CronProduction.cron_sync_status.__globals__['requests'] = SimpleNamespace(post=post)
    CronProduction.cron_sync_status.__globals__['db_now_utc'] = lambda _cr: datetime.datetime(2026,10,9,10,0,0)
    r = Router()
    first = r.cron_sync_status()
    second = r.cron_sync_status()
    assert first == 100 and second == 100
    assert sorted(i for page in seen for i in page)[:3] == [1, 1, 2]
    assert 101 not in [j for page in seen[:2] for j in page]
    assert 101 in [j for page in seen[2:] for j in page], 'Oldest 100 starve the 101st in every cron run'
    assert db.execute('SELECT last_status_polled_at FROM print_gateway_print_job WHERE id=101').fetchone()[0]
    db.close()
