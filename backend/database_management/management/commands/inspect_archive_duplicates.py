"""
READ-ONLY inspection of archive integrity. Changes nothing.

    python manage.py inspect_archive_duplicates

Reports:
  * archived snapshots whose original violation is STILL in the active table
    (same identity  -> duplicate, excluded from every statistic;
     different identity -> id conflict, both are counted);
  * original ids archived more than once;
  * archived rows with no usable created_at: their duplicate detection falls
    back to (id, date_issued), the weakest identity — listed for review;
  * archived rows whose stored violation_year differs from the Asia/Manila
    year of date_issued (rows written by older runs that used the UTC year).
"""
from django.core.management.base import BaseCommand
from django.db.models import Count

from database_management.historical import (
    active_identity_matches, archived_identity, has_strong_identity, manila_year,
)
from database_management.models import ArchivedViolation
from violations.models import Violation


class Command(BaseCommand):
    help = 'Read-only: report duplicate / conflicting / mis-yeared archived violations.'

    def handle(self, *args, **options):
        out = self.stdout.write

        # 1. archived vs active
        dup_active, conflict_active = [], []
        clash = ArchivedViolation.objects.filter(
            original_violation_id__in=Violation.objects.values('id')
        ).values_list('pk', 'original_violation_id', 'date_issued', 'data__created_at')
        active = {
            v: (c, d) for v, c, d in Violation.objects.filter(
                id__in=ArchivedViolation.objects.values('original_violation_id')
            ).values_list('id', 'created_at', 'date_issued')
        }
        for pk, oid, issued, snap_created in clash:
            ident = archived_identity(oid, snap_created, issued)
            if active_identity_matches(ident, *active[oid]):
                dup_active.append((pk, oid))
            else:
                conflict_active.append((pk, oid))

        # 1b. rows whose duplicate/conflict decision rests on the WEAK identity
        weak = [
            (pk, oid) for pk, oid, snap_created in ArchivedViolation.objects.values_list(
                'pk', 'original_violation_id', 'data__created_at').iterator()
            if not has_strong_identity(snap_created)
        ]

        # 2. archived more than once
        repeated = list(
            ArchivedViolation.objects.values('original_violation_id')
            .annotate(n=Count('id')).filter(n__gt=1).order_by('original_violation_id')
        )

        # 3. year mismatches
        mismatched = [
            (pk, oid, stored, manila_year(issued))
            for pk, oid, stored, issued in ArchivedViolation.objects.values_list(
                'pk', 'original_violation_id', 'violation_year', 'date_issued').iterator()
            if stored != manila_year(issued)
        ]

        out('Archive integrity report (read-only; nothing was modified)')
        out(f'  archived rows total                         : {ArchivedViolation.objects.count()}')
        out(f'  duplicates of a still-ACTIVE violation       : {len(dup_active)}')
        for pk, oid in dup_active[:50]:
            out(f'      archived pk={pk} original_violation_id={oid}')
        out(f'  id conflicts with a DIFFERENT active record  : {len(conflict_active)}')
        for pk, oid in conflict_active[:50]:
            out(f'      archived pk={pk} original_violation_id={oid}')
        out(f'  original ids archived more than once         : {len(repeated)}')
        for r in repeated[:50]:
            out(f"      original_violation_id={r['original_violation_id']} x{r['n']}")
        out(f'  snapshots WITHOUT usable created_at (weak id): {len(weak)}')
        for pk, oid in weak[:50]:
            out(f'      archived pk={pk} original_violation_id={oid} (matched on id + date_issued only)')
        out(f'  stored violation_year != Asia/Manila year    : {len(mismatched)}')
        for pk, oid, stored, real in mismatched[:50]:
            out(f'      archived pk={pk} original={oid} stored={stored} manila={real}')
        out('Duplicates are excluded from analytics/reports/public stats automatically; '
            'no rows were changed or deleted.')