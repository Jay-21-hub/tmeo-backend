import json
from decimal import Decimal

from django.db import connection, transaction
from django.db.models import Count
from django.utils import timezone

from violations.models import Violation
from .historical import (
    active_identity_matches, archived_identity, manila_year,
)
from .models import ArchiveBatch, ArchivedViolation


class ArchiveReconciliationError(Exception):
    """Raised when archived-record count doesn't match the active count."""
    pass


class ArchiveBusyError(Exception):
    """Raised when another archive run currently holds the archive lock."""
    pass


# PostgreSQL advisory-lock key ("TMEOARCH" as a 63-bit integer). Only ONE
# archive run may execute at a time; a second caller is refused (HTTP 409)
# instead of waiting, so a double-click or two admins can never interleave.
ARCHIVE_ADVISORY_LOCK_KEY = 0x544D454F41524348


def _acquire_archive_lock():
    """Transaction-scoped advisory lock: released automatically on commit or
    rollback, so a crash can never leave it stuck. No-op on non-PostgreSQL
    databases (local SQLite test runs), where there is no concurrency."""
    if connection.vendor != 'postgresql':
        return
    with connection.cursor() as cur:
        cur.execute('SELECT pg_try_advisory_xact_lock(%s)', [ARCHIVE_ADVISORY_LOCK_KEY])
        if not cur.fetchone()[0]:
            raise ArchiveBusyError('Another archive operation is already running. Try again shortly.')


def _snapshot_violation(violation):
    """Full JSON-safe snapshot of one Violation's business fields.

    PART 5/6 payment data (#005): the related `Assessment` row is CASCADE-
    deleted the moment its `Violation` is deleted below, and it holds the
    ONLY record of `or_number`, `amount_paid`, `received_by`, and the real
    `date_paid` — none of which live on Violation itself. If this snapshot
    doesn't capture them first, that payment info is gone permanently the
    instant a settled ticket is archived. `violation.assessment` may not
    exist yet (e.g. a still-pending record with no Staff action taken),
    hence the `getattr(..., None)` guard.
    """
    items = [
        {
            'code': i.violation_type.code if i.violation_type else '',
            'name': i.violation_type.name if i.violation_type else '',
            'category': i.violation_type.category if i.violation_type else '',
            'penalty_amount': float(i.penalty_amount_snapshot),
        }
        for i in violation.items.all()
    ]
    # Archive hardening (Checkpoint 1). The ticket photo file itself is not
    # deleted with the row, but its PATH lived only on the row; the offline
    # id is what lets a late replay of this ticket be recognised as already
    # archived; evidence ids tie the snapshot to the relinked evidence rows.
    # `evidence` is prefetched by _run_archive_locked (no N+1); sorted so the
    # snapshot is deterministic. Additive keys only.
    evidence_ids = sorted(e.id for e in violation.evidence.all())
    assessment = getattr(violation, 'assessment', None)
    assessment_snapshot = None
    if assessment is not None:
        assessment_snapshot = {
            'or_number':        assessment.or_number,
            'penalty':          float(assessment.penalty) if assessment.penalty is not None else None,
            'amount_paid':      float(assessment.amount_paid) if assessment.amount_paid is not None else None,
            'received_by':      assessment.received_by,
            'date_paid':        assessment.date_paid.isoformat() if assessment.date_paid else None,
            'assessed_by_name': assessment.assessed_by.full_name if assessment.assessed_by_id else '',
            'assessor_name_snapshot':      assessment.assessor_name_snapshot,
            'assessor_role_snapshot':      assessment.assessor_role_snapshot,
            'assessor_id_number_snapshot': assessment.assessor_id_number_snapshot,
            'assessor_snapshot_source':    assessment.assessor_snapshot_source,
            'assessed_at':      assessment.assessed_at.isoformat() if assessment.assessed_at else None,
            # Payment confirmer (Role Evolution, Phase 2) — a different actor
            # from the assessor. Additive keys only.
            'payment_confirmed_by_name':           assessment.payment_confirmed_by.full_name if assessment.payment_confirmed_by_id else '',
            'payment_confirmed_at':                assessment.payment_confirmed_at.isoformat() if assessment.payment_confirmed_at else None,
            'payment_confirmer_name_snapshot':      assessment.payment_confirmer_name_snapshot,
            'payment_confirmer_role_snapshot':      assessment.payment_confirmer_role_snapshot,
            'payment_confirmer_id_number_snapshot': assessment.payment_confirmer_id_number_snapshot,
            'payment_confirmer_snapshot_source':    assessment.payment_confirmer_snapshot_source,
            'notes':            assessment.notes,
        }
    return {
        'id': violation.id,
        'violator_name': violation.violator_name,
        'license_number': violation.license_number,
        'license_status': violation.get_license_status_display(),
        # Confiscated-document details (internal record fields). Additive keys.
        'confiscated_document_type': violation.confiscated_document_type,
        'confiscated_document_name': violation.confiscated_document_name,
        'confiscated_document_number': violation.confiscated_document_number,
        'plate_number': violation.plate_number,
        'registration_number': violation.registration_number,
        'vehicle_type': violation.vehicle_type,
        'vehicle_brand': violation.vehicle_brand,
        'vehicle_model': violation.vehicle_model,
        'vehicle_use': violation.vehicle_use,
        'address': violation.address,
        'ovr_number': violation.ovr_number,
        'client_offline_id': violation.client_offline_id or None,
        'image': violation.image.name if violation.image else None,
        'evidence_ids': evidence_ids,
        'source': violation.source,
        'location': violation.location,
        'latitude': violation.latitude,
        'longitude': violation.longitude,
        'date_issued': violation.date_issued.isoformat() if violation.date_issued else None,
        'remarks': violation.remarks,
        'penalty_amount': float(violation.penalty_amount),
        'status': violation.get_status_display(),
        'enforcer_name': violation.enforcer.full_name if violation.enforcer_id else '',
        # Phase 3 (additive): stable person id so archived rows group with the
        # same person's active rows even after a rename / role change.
        'enforcer_user_id': violation.enforcer_id,
        # Event-time identity snapshots (Role Evolution, Phase 1). Archiving
        # deletes the active row, so copy them here or they are lost. Additive
        # keys only; the live-name keys above are unchanged.
        'enforcer_name_snapshot':      violation.enforcer_name_snapshot,
        'enforcer_role_snapshot':      violation.enforcer_role_snapshot,
        'enforcer_id_number_snapshot': violation.enforcer_id_number_snapshot,
        'enforcer_badge_snapshot':     violation.enforcer_badge_snapshot,
        'enforcer_snapshot_source':    violation.enforcer_snapshot_source,
        'assessed_by_name': violation.assessed_by.full_name if violation.assessed_by_id else '',
        'assessed_at': violation.assessed_at.isoformat() if violation.assessed_at else None,
        'assessment_notes': violation.assessment_notes,
        'is_printed': violation.is_printed,
        'created_at': violation.created_at.isoformat() if violation.created_at else None,
        'updated_at': violation.updated_at.isoformat() if violation.updated_at else None,
        'items': items,
        # Payment record (#005) — None when no Assessment was ever created.
        'assessment': assessment_snapshot,
    }


# Processing-status values that mean "staff has not finished working this
# record yet" (PART 5/6/8: processing status is a separate axis from
# settlement status). A record in one of these states — or currently
# locked by a staff member for an active Resume session — must never be
# removed from the active table by the archive operation, regardless of
# its settlement status.
IN_PROGRESS_STATUSES = (Violation.Status.PENDING, Violation.Status.PROCESSING)


def _is_in_progress(v):
    """True if this Violation's staff workflow is not yet finished, i.e.
    it must stay in the active table (PART 8/17/18)."""
    return v.status in IN_PROGRESS_STATUSES or v.locked_by_id is not None


def get_archive_preview():
    """
    Read-only summary used by the confirmation dialog (PART 21) — how many
    active records exist right now, how many are actually eligible to be
    archived this run, and how they'd break down by year.

    "Eligible" excludes any record whose staff processing workflow is not
    yet finished (status pending/processing, or currently locked) — those
    stay active no matter their settlement status, so an in-progress
    Resume session is never destroyed by an archive run (PART 8).
    """
    active_count = Violation.objects.count()
    in_progress_count = 0
    year_breakdown = {}
    candidates = []   # (id, created_at, date_issued) of records not in progress
    for v in Violation.objects.only(
            'date_issued', 'created_at', 'status', 'locked_by_id').iterator():
        year = manila_year(v.date_issued) if v.date_issued else 0
        bucket = year_breakdown.setdefault(
            year, {'settled': 0, 'unsettled': 0, 'total': 0, 'in_progress': 0,
                   'already_archived': 0, 'conflict': 0}
        )
        bucket['total'] += 1
        if v.status == 'paid':
            bucket['settled'] += 1
        else:
            bucket['unsettled'] += 1
        if _is_in_progress(v):
            bucket['in_progress'] += 1
            in_progress_count += 1
        else:
            candidates.append((v.id, v.created_at, v.date_issued, year))

    # Records the next run would NOT archive because a snapshot already exists
    # (same violation) or the id clashes with a different archived violation.
    existing = _find_existing_archives([c[0] for c in candidates])
    already_archived = conflicts = 0
    for vid, created, issued, year in candidates:
        prior = existing.get(vid)
        if not prior:
            continue
        if any(active_identity_matches(p, created, issued) for p in prior):
            already_archived += 1
            year_breakdown[year]['already_archived'] += 1
        else:
            conflicts += 1
            year_breakdown[year]['conflict'] += 1
    return {
        'active_count': active_count,
        'eligible_count': active_count - in_progress_count - already_archived - conflicts,
        'in_progress_count': in_progress_count,
        'already_archived_active_count': already_archived,
        'archive_conflict_count': conflicts,
        'year_breakdown': [
            {'year': y, **counts} for y, counts in sorted(year_breakdown.items())
        ],
    }


def _settled_at_for(violation, assessment):
    """
    Best-available settlement TIMESTAMP for an archived record (#005).
    `Assessment.date_paid` is a DATE (the real payment/O.R. date) — convert
    to an aware datetime at midnight. Falls back to `Assessment.assessed_at`
    (a real datetime) if `date_paid` is somehow blank on a paid record.
    Returns None for anything not actually paid, or with no Assessment.
    """
    if violation.status != 'paid' or assessment is None:
        return None
    if assessment.date_paid:
        return timezone.make_aware(
            timezone.datetime.combine(assessment.date_paid, timezone.datetime.min.time())
        )
    return assessment.assessed_at


def _json_normal(value):
    """JSON round-trip, exactly what the database stores and returns."""
    return json.loads(json.dumps(value))


def diff_snapshots(expected, actual, path=''):
    """Strict structural comparison of two JSON documents.

    Returns a list of dotted paths whose value is missing, extra, of a
    different type, or different. Nothing is tolerated except the one thing
    JSON itself does not distinguish: 500 and 500.0 are the same number
    (compared by exact value, no rounding). Strings (including ISO dates),
    booleans, None vs '' and list order/length are all compared exactly, so a
    meaningful difference can never be masked. Values are never returned —
    only paths — so no personal data ends up in an error message.
    """
    def is_num(x):
        return isinstance(x, (int, float, Decimal)) and not isinstance(x, bool)

    if isinstance(expected, dict) and isinstance(actual, dict):
        out = []
        for k in sorted(set(expected) | set(actual)):
            sub = f'{path}.{k}' if path else str(k)
            if k not in actual:
                out.append(f'{sub} (missing)')
            elif k not in expected:
                out.append(f'{sub} (unexpected)')
            else:
                out.extend(diff_snapshots(expected[k], actual[k], sub))
        return out
    if isinstance(expected, list) and isinstance(actual, list):
        if len(expected) != len(actual):
            return [f'{path} (length {len(expected)} != {len(actual)})']
        out = []
        for i, (e, a) in enumerate(zip(expected, actual)):
            out.extend(diff_snapshots(e, a, f'{path}[{i}]'))
        return out
    if is_num(expected) and is_num(actual):
        return [] if Decimal(str(expected)) == Decimal(str(actual)) else [f'{path} (changed)']
    if type(expected) is not type(actual) or expected != actual:
        return [path or '(root)']
    return []


def _verify_written_archive(batch, eligible, expected_snapshots):
    """Read every archived row of this batch back from the database and prove
    that it is complete BEFORE any active record is deleted. Returns a list of
    human-readable problems (empty = verified)."""
    problems = []
    written = {a.original_violation_id: a for a in ArchivedViolation.objects.filter(batch=batch)}
    eligible_ids = [v.id for v in eligible]

    if len(written) != len(eligible):
        problems.append(f"{len(eligible)} eligible records but only {len(written)} archived successfully")
    if set(written) != set(eligible_ids):
        problems.append('archived id set differs from the eligible id set')

    # Independent source of truth: the live related rows, not the snapshot code.
    item_counts = dict(
        Violation.objects.filter(id__in=eligible_ids).values_list('id').annotate(n=Count('items'))
    )
    from violations.models import Assessment
    has_assessment = set(Assessment.objects.filter(violation_id__in=eligible_ids)
                         .values_list('violation_id', flat=True))

    for v in eligible:
        row = written.get(v.id)
        if row is None:
            continue
        bad = diff_snapshots(expected_snapshots[v.id], row.data)
        # Column-level fields that mirror the snapshot.
        cols = {
            'violation_year': (manila_year(v.date_issued), row.violation_year),
            'date_issued': (v.date_issued, row.date_issued),
            'violator_name': (v.violator_name, row.violator_name),
            'license_number': (v.license_number, row.license_number),
            'plate_number': (v.plate_number, row.plate_number),
            'settlement_status': (
                ArchivedViolation.Settlement.SETTLED if v.status == 'paid'
                else ArchivedViolation.Settlement.UNSETTLED, row.settlement_status),
        }
        bad += [f'column {k}' for k, (e, a) in cols.items() if e != a]
        if len((row.data or {}).get('items') or []) != item_counts.get(v.id, 0):
            bad.append('items (count differs from live ViolationItem rows)')
        if ((row.data or {}).get('assessment') is not None) != (v.id in has_assessment):
            bad.append('assessment (presence differs from live Assessment row)')
        if bad:
            problems.append(f"snapshot of #{v.id} differs from the original: {', '.join(bad[:8])}"
                            f"{' …' if len(bad) > 8 else ''}")
            if len(problems) >= 5:
                break
    return problems


def _relink_evidence(eligible, batch):
    """Move the evidence of every eligible violation from the (about to be
    deleted) active ticket to its ArchivedViolation snapshot.

    Returns {original_violation_id: sorted evidence ids} as it was BEFORE the
    relink (taken from the prefetched rows), for verification."""
    from violations.models import ViolationEvidence
    archived_pk = dict(
        ArchivedViolation.objects.filter(batch=batch)
        .values_list('original_violation_id', 'pk')
    )
    expected = {}
    for v in eligible:
        ids = sorted(e.id for e in v.evidence.all())
        if not ids:
            continue
        expected[v.id] = ids
        # ONE statement sets the archived link and clears the active link.
        ViolationEvidence.objects.filter(violation_id=v.id).update(
            archived_violation_id=archived_pk[v.id], violation=None,
        )
    return expected


def _relink_custody(eligible, batch):
    """Relink custody rows of eligible violations to their snapshots.

    Lock order matches the custody service: violation rows are already locked
    by this run, so we now lock the custody rows. Returns
    {original_violation_id: (custody_pk, archived_pk)} for verification."""
    from violations.custody_models import LicenseCustody
    archived_pk = dict(
        ArchivedViolation.objects.filter(batch=batch)
        .values_list('original_violation_id', 'pk')
    )
    ids = [v.id for v in eligible]
    existing = {
        c.violation_id: c for c in
        LicenseCustody.objects.select_for_update().filter(violation_id__in=ids)
    }
    expected = {}
    for v in eligible:
        apk = archived_pk[v.id]
        c = existing.get(v.id)
        if c is None:
            blank = (v.confiscated_document_type or '') == ''
            if v.license_status == 'confiscated' and blank:
                c = LicenseCustody.objects.create(
                    archived_violation_id=apk, original_violation_id=v.id,
                    doc_type_status=LicenseCustody.DocTypeStatus.PENDING, version=1,
                )
                expected[v.id] = (c.pk, apk)
            continue
        # ONE statement sets the archived link and clears the active link.
        LicenseCustody.objects.filter(pk=c.pk).update(archived_violation_id=apk, violation=None)
        expected[v.id] = (c.pk, apk)
    return expected


def _verify_relinked_custody(batch, eligible, expected):
    """Read back from the database: no custody row may still point at an
    archived-away violation, every relinked row points at the right snapshot
    with a matching original id."""
    from violations.custody_models import LicenseCustody
    problems = []
    ids = [v.id for v in eligible]
    if LicenseCustody.objects.filter(violation_id__in=ids).exists():
        problems.append('a custody row still points at an archived-away violation')
    rows = {c.pk: c for c in LicenseCustody.objects.filter(pk__in=[p for p, _ in expected.values()])}
    for orig, (cpk, apk) in expected.items():
        c = rows.get(cpk)
        if c is None:
            problems.append(f'custody #{cpk} of violation #{orig} disappeared')
        elif c.archived_violation_id != apk or c.violation_id is not None or c.original_violation_id != orig:
            problems.append(f'custody #{cpk} of violation #{orig} is not linked to its snapshot')
    return problems


def _verify_relinked_evidence(batch, eligible, expected, after_delete=False):
    """Read the evidence rows back from the database (not from the prefetch)
    and prove each one is linked to the right snapshot. Returns a list of
    problems (empty = verified)."""
    from violations.models import ViolationEvidence
    problems = []
    archived_pk = dict(
        ArchivedViolation.objects.filter(batch=batch)
        .values_list('original_violation_id', 'pk')
    )
    eligible_ids = [v.id for v in eligible]

    # Nothing may still hang off an active ticket that is about to go / has gone.
    if ViolationEvidence.objects.filter(violation_id__in=eligible_ids).exists():
        problems.append('evidence is still linked to an active violation')

    linked = {}
    for eid, apk in ViolationEvidence.objects.filter(
        archived_violation__batch=batch
    ).values_list('id', 'archived_violation_id'):
        linked.setdefault(apk, []).append(eid)

    for oid, ids in expected.items():
        got = sorted(linked.get(archived_pk[oid], []))
        if got != ids:
            problems.append(
                f"evidence of #{oid} is {got} after relink, expected {ids}"
                f"{' (after delete)' if after_delete else ''}"
            )
            if len(problems) >= 5:
                break

    # The snapshot's own record of the evidence ids must agree with reality.
    for a in ArchivedViolation.objects.filter(batch=batch):
        snap_ids = sorted((a.data or {}).get('evidence_ids') or [])
        if snap_ids != sorted(linked.get(a.pk, [])):
            problems.append(f"snapshot evidence_ids of archived #{a.original_violation_id} "
                            f"differ from the relinked evidence")
            if len(problems) >= 5:
                break
    return problems


def _find_existing_archives(ids):
    """original_violation_id -> [archived identity, ...] for already-archived ids."""
    existing = {}
    for oid, issued, snap_created in (
        ArchivedViolation.objects.filter(original_violation_id__in=ids)
        .values_list('original_violation_id', 'date_issued', 'data__created_at')
    ):
        existing.setdefault(oid, []).append(archived_identity(oid, snap_created, issued))
    return existing


def run_archive(user):
    """
    Executes the archive operation. Returns the completed ArchiveBatch on
    success. Raises ArchiveReconciliationError (transaction rolls back
    entirely, so no data is touched) on any mismatch or failure, and
    ArchiveBusyError when another archive run holds the advisory lock.

    Safety properties:
      * single-flight   — PostgreSQL advisory lock (refused, never queued);
      * row-locked      — eligible rows are SELECT ... FOR UPDATE, so staff
                          cannot start working a record mid-archive;
      * idempotent      — a violation whose snapshot already exists is NOT
                          archived a second time (it is left untouched);
      * conflict-aware  — same id but different identity (created_at) is
                          reported and left untouched, never overwritten;
      * verified        — archived rows are read back and checked, and the
                          number of rows actually deleted must equal the
                          number archived, else everything rolls back;
      * Manila year     — violation_year comes from the Asia/Manila date.

    Records whose staff processing is still in progress (status pending or
    processing, or currently locked for an active Resume session) are
    never archived-and-removed here — they stay in the active table
    untouched, and become eligible on a future archive run once their
    processing is finished (PART 8/17/18: an export/archive must not
    destroy an active workflow). Their settlement status is irrelevant to
    this decision — a fully-assessed record with settlement still pending
    is eligible; a record staff hasn't finished assessing is not.

    The returned batch carries two NON-persisted counters (no migration):
    ``skipped_already_archived_count`` and ``archive_conflict_count``.
    """
    with transaction.atomic():
        _acquire_archive_lock()
        return _run_archive_locked(user)


def _run_archive_locked(user):
    active_qs = Violation.objects.select_related(
        'enforcer', 'assessed_by', 'assessment', 'assessment__assessed_by',
        'assessment__payment_confirmed_by'
    ).prefetch_related(
        'items__violation_type', 'evidence'
    ).order_by('id')
    # Lock only the Violation rows themselves (not the LEFT-JOINed tables).
    active_all = list(active_qs.select_for_update(of=('self',)))
    active_count_before = len(active_all)

    batch = ArchiveBatch.objects.create(
        created_by=user,
        status=ArchiveBatch.Status.IN_PROGRESS,
        active_count_before=active_count_before,
    )
    batch.skipped_already_archived_count = 0
    batch.archive_conflict_count = 0

    if active_count_before == 0:
        # Nothing to archive — not an error, just a no-op success.
        batch.status = ArchiveBatch.Status.SUCCESS
        batch.archived_count = 0
        batch.save(update_fields=['status', 'archived_count'])
        return batch

    candidates = [v for v in active_all if not _is_in_progress(v)]
    skipped_in_progress_count = active_count_before - len(candidates)

    # ── idempotency / conflict detection ────────────────────────────────
    existing = _find_existing_archives([v.id for v in candidates])
    eligible = []
    for v in candidates:
        prior = existing.get(v.id)
        if not prior:
            eligible.append(v)
            continue
        if any(active_identity_matches(p, v.created_at, v.date_issued) for p in prior):
            batch.skipped_already_archived_count += 1   # same violation, already archived
        else:
            batch.archive_conflict_count += 1           # same id, different violation

    if not eligible:
        # Everything left is in progress / already archived / conflicting —
        # nothing is safe to move, but that's a valid outcome, not an error.
        batch.status = ArchiveBatch.Status.SUCCESS
        batch.archived_count = 0
        batch.skipped_in_progress_count = skipped_in_progress_count
        batch.save(update_fields=['status', 'archived_count', 'skipped_in_progress_count'])
        return batch

    to_create = []
    expected_snapshots = {}
    for v in eligible:
        assessment = getattr(v, 'assessment', None)
        snapshot = _snapshot_violation(v)
        # What the database must hand back later (independent deep copy).
        expected_snapshots[v.id] = _json_normal(snapshot)
        to_create.append(ArchivedViolation(
            batch=batch,
            original_violation_id=v.id,
            # Asia/Manila calendar year of date_issued (NOT the UTC year).
            violation_year=manila_year(v.date_issued),
            date_issued=v.date_issued,
            settlement_status=(
                ArchivedViolation.Settlement.SETTLED
                if v.status == 'paid' else ArchivedViolation.Settlement.UNSETTLED
            ),
            # #005: real settlement timestamp from the Assessment (payment)
            # record, not a guess off Violation.updated_at (which is just
            # "last touched" and could be overwritten by an unrelated
            # later edit).
            settled_at=_settled_at_for(v, assessment),
            violator_name=v.violator_name,
            license_number=v.license_number,
            plate_number=v.plate_number,
            data=snapshot,
        ))

    ArchivedViolation.objects.bulk_create(to_create)

    # ── verification: read the archive back, do not trust bulk_create ───
    # Complete content comparison (every business field, confiscated-document
    # fields, assessment/payment data, items) BEFORE anything is deleted.
    eligible_ids = [v.id for v in eligible]
    written = list(ArchivedViolation.objects.filter(batch=batch).values_list('pk', flat=True))
    problems = _verify_written_archive(batch, eligible, expected_snapshots)
    if problems:
        # Raising inside the atomic block rolls back the bulk_create
        # AND the batch row itself — nothing is left behind.
        raise ArchiveReconciliationError(
            f"Reconciliation failed: {'; '.join(problems)} (batch #{batch.id})."
        )

    # ── evidence preservation (Checkpoint 1) ────────────────────────────
    # Deleting a Violation sets ViolationEvidence.violation to NULL, which
    # would turn its photos into look-alike "standalone" captures that can be
    # re-associated to another ticket. Relink them to the archive snapshot
    # FIRST. Each relink is ONE UPDATE that sets archived_violation and clears
    # violation together, so evidence_active_xor_archived_link holds at every
    # statement. Everything is inside the archive transaction.
    expected_evidence = _relink_evidence(eligible, batch)
    problems = _verify_relinked_evidence(batch, eligible, expected_evidence)
    if problems:
        raise ArchiveReconciliationError(
            f"Evidence relink verification failed: {'; '.join(problems)} (batch #{batch.id})."
        )

    # ── license custody (Checkpoint 3) ──────────────────────────────────
    # Custody must survive the delete below: each custody row is relinked from
    # the active ticket to its archive snapshot in ONE UPDATE (the exactly-one
    # link check holds at every statement), and legacy blank-type confiscated
    # records get a pending custody row so they are preserved, not dropped.
    expected_custody = _relink_custody(eligible, batch)
    problems = _verify_relinked_custody(batch, eligible, expected_custody)
    if problems:
        raise ArchiveReconciliationError(
            f"License custody relink verification failed: {'; '.join(problems)} (batch #{batch.id})."
        )

    # Reconciliation passed — clear only the records we actually archived.
    # In-progress, already-archived and conflicting records were never touched.
    _total_deleted, per_model = Violation.objects.filter(id__in=eligible_ids).delete()
    deleted_violations = per_model.get(Violation._meta.label, 0)
    if deleted_violations != len(eligible_ids) or Violation.objects.filter(id__in=eligible_ids).exists():
        raise ArchiveReconciliationError(
            f"Delete verification failed: expected to remove {len(eligible_ids)} active "
            f"record(s) but removed {deleted_violations} (batch #{batch.id}). Rolled back."
        )

    # After the delete: every evidence row must still exist, be linked to its
    # archive snapshot, and no longer point at an active violation.
    problems = _verify_relinked_evidence(batch, eligible, expected_evidence, after_delete=True)
    if problems:
        raise ArchiveReconciliationError(
            f"Evidence verification after delete failed: {'; '.join(problems)} "
            f"(batch #{batch.id}). Rolled back."
        )

    batch.status = ArchiveBatch.Status.SUCCESS
    batch.archived_count = len(written)
    batch.skipped_in_progress_count = skipped_in_progress_count
    batch.save(update_fields=['status', 'archived_count', 'skipped_in_progress_count'])
    return batch