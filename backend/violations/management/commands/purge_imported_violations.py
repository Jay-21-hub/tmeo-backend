"""
Purge Excel-imported violation records (source='imported').

SAFE BY DEFAULT: running without --execute is a DRY RUN (nothing is deleted).

Only rows with source='imported' are ever touched. Manual records
(enforcer_ovr / staff_walk_in) are never selected.
PAID imported rows are always SKIPPED (they carry payment / O.R. data).
--execute FIRST writes a JSON backup of every row to be deleted; if the
backup cannot be written, nothing is deleted.

Usage (from the backend folder):
  python manage.py purge_imported_violations
  python manage.py purge_imported_violations --since 2026-11-09
  python manage.py purge_imported_violations --execute --confirm-count 986
"""
import datetime
import json
import os

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.db.models import Count, ProtectedError
from django.utils import timezone

from violations.models import Violation


def _row_dump(v):
    data = {}
    for f in v._meta.concrete_fields:
        data[f.attname] = getattr(v, f.attname)
    data['_items'] = [
        {'code': i.violation_type.code, 'name': i.violation_type.name,
         'penalty_amount_snapshot': i.penalty_amount_snapshot}
        for i in v.items.all()
    ]
    a = getattr(v, 'assessment', None) if hasattr(v, 'assessment') else None
    if a is not None:
        data['_assessment'] = {f.attname: getattr(a, f.attname) for f in a._meta.concrete_fields}
    return data


class Command(BaseCommand):
    help = 'Delete Excel-imported violations (source=imported). Dry run unless --execute.'

    def add_arguments(self, parser):
        parser.add_argument('--since', help='Only rows created on/after this date (YYYY-MM-DD, Manila).')
        parser.add_argument('--execute', action='store_true', help='Actually delete. Without it: dry run.')
        parser.add_argument('--confirm-count', type=int,
                            help='Required with --execute. Must equal the deletable count shown by the dry run.')
        parser.add_argument('--show', type=int, default=30, help='How many sample rows to print (default 30).')
        parser.add_argument('--backup-dir', default='.', help='Folder for the JSON backup (default: current folder).')

    def handle(self, *args, **opts):
        qs = Violation.objects.filter(source=Violation.Source.IMPORTED)

        if opts['since']:
            try:
                d = datetime.date.fromisoformat(opts['since'])
            except ValueError:
                raise CommandError('--since must be YYYY-MM-DD')
            start = timezone.make_aware(datetime.datetime.combine(d, datetime.time.min))
            qs = qs.filter(created_at__gte=start)

        total = qs.count()
        paid = qs.filter(status=Violation.Status.PAID)
        deletable = qs.exclude(status=Violation.Status.PAID)
        n_del = deletable.count()

        self.stdout.write(self.style.MIGRATE_HEADING('=== Imported violations (source=imported) ==='))
        self.stdout.write(f'Total matched:            {total}')
        self.stdout.write(f'PAID (will be SKIPPED):   {paid.count()}')
        self.stdout.write(f'Deletable (non-paid):     {n_del}')

        for row in deletable.values('status').annotate(c=Count('id')).order_by('status'):
            self.stdout.write(f"  - {row['status']}: {row['c']}")
        for row in deletable.values('imported_by__full_name').annotate(c=Count('id')):
            self.stdout.write(f"  - uploaded by {row['imported_by__full_name']}: {row['c']}")

        first = deletable.order_by('created_at').first()
        last = deletable.order_by('created_at').last()
        if first and last:
            self.stdout.write(f'Created range: {timezone.localtime(first.created_at):%Y-%m-%d %H:%M} '
                              f'-> {timezone.localtime(last.created_at):%Y-%m-%d %H:%M} (Manila)')

        touched = deletable.filter(assessment__isnull=False).count()
        if touched:
            self.stdout.write(self.style.WARNING(
                f'WARNING: {touched} deletable row(s) already have an Assessment record '
                '(someone opened/assessed them). It will be deleted together with the row.'))

        non_pending = deletable.exclude(status=Violation.Status.PENDING).order_by('id')
        if non_pending.exists():
            self.stdout.write('\nNon-pending rows (already worked on):')
            for v in non_pending:
                self.stdout.write(f'  #{v.id}  {v.status:<10} {timezone.localtime(v.date_issued):%Y-%m-%d}  '
                                  f'{v.plate_number:<10} {v.violator_name}  '
                                  f'assessed_by={v.assessed_by_id} locked_by={v.locked_by_id}')

        self.stdout.write('\nSample (oldest first):')
        for v in deletable.order_by('created_at')[:opts['show']]:
            self.stdout.write(f'  #{v.id}  {v.status:<10} {timezone.localtime(v.date_issued):%Y-%m-%d}  '
                              f'{v.plate_number:<10} {v.violator_name}')

        if not opts['execute']:
            self.stdout.write(self.style.SUCCESS(
                f'\nDRY RUN only. Nothing deleted. To delete run again with:\n'
                f'  --execute --confirm-count {n_del}'
                + (f" --since {opts['since']}" if opts['since'] else '')
                + '\n(a JSON backup file is written first)'))
            return

        if opts['confirm_count'] != n_del:
            raise CommandError(f'--confirm-count must equal {n_del} (the deletable count). Nothing deleted.')

        # ── Backup FIRST. Any failure here aborts before a single delete. ──
        stamp = timezone.localtime().strftime('%Y%m%d_%H%M%S')
        path = os.path.abspath(os.path.join(opts['backup_dir'], f'imported_violations_backup_{stamp}.json'))
        try:
            dump = [_row_dump(v) for v in deletable.select_related('assessment')
                    .prefetch_related('items__violation_type').order_by('id')]
            with open(path, 'w', encoding='utf-8') as fh:
                json.dump({'created': stamp, 'count': len(dump), 'records': dump},
                          fh, default=str, ensure_ascii=False, indent=1)
            if os.path.getsize(path) == 0 or len(dump) != n_del:
                raise RuntimeError('backup incomplete')
        except Exception as exc:  # noqa: BLE001
            raise CommandError(f'Backup failed ({exc}). Nothing deleted.')
        self.stdout.write(self.style.SUCCESS(f'Backup written: {path} ({n_del} records)'))

        deleted, blocked = [], []
        for v in list(deletable):
            try:
                with transaction.atomic():
                    vid = v.id
                    v.delete()
                deleted.append(vid)
            except ProtectedError:
                blocked.append(v.id)

        self.stdout.write(self.style.SUCCESS(f'\nDeleted: {len(deleted)}'))
        if blocked:
            self.stdout.write(self.style.WARNING(
                f'Blocked (protected, e.g. license custody): {len(blocked)} -> ids {blocked}'))

        # Audit trail (best effort; never blocks the purge result)
        try:
            from audit.models import AuditLog
            AuditLog.objects.create(
                user=None, action='DELETE', module='Violations',
                description=f'Purged {len(deleted)} imported violation record(s) via management command.',
                details={'deleted_count': len(deleted), 'violation_ids': deleted, 'blocked_ids': blocked,
                         'backup_file': os.path.basename(path)},
            )
        except Exception as exc:  # noqa: BLE001
            self.stdout.write(self.style.WARNING(f'Audit log entry not written: {exc}'))