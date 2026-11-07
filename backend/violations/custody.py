"""
Confiscated Licenses service layer (Checkpoint 3, Stage B).

Everything that changes custody state goes through `execute()`:

  1. take locks in ONE fixed order - violation row, (archived row), custody
     row - so release and archive can never deadlock;
  2. re-check idempotency INSIDE the lock, so a concurrent duplicate replays
     instead of failing with a version conflict;
  3. check `expected_version`, apply the operation, bump the version;
  4. append an immutable event (fingerprint + client_request_id).

Full claimant ID numbers are never accepted, stored, logged or audited.
"""
import hashlib
import json
import re
from dataclasses import dataclass
from typing import Optional

from django.db import IntegrityError, transaction
from django.utils import timezone

from audit.utils import log_action
from database_management.models import ArchivedViolation

from .custody_models import LicenseCustody, LicenseCustodyEvent
from .models import Violation

DL = 'drivers_license'
LAST4_RE = re.compile(r'^[A-Za-z0-9]{0,4}$')
OK_FOR_RELEASE = (LicenseCustody.DocTypeStatus.NOT_REQUIRED, LicenseCustody.DocTypeStatus.CONFIRMED)


class CustodyError(Exception):
    def __init__(self, code, message, status=409, **extra):
        super().__init__(message)
        self.code, self.message, self.status, self.extra = code, message, status, extra


class _IdempotencyRace(Exception):
    pass


@dataclass
class Target:
    kind: str                          # 'active' | 'archived'
    violation: Optional[Violation]
    archived: Optional[ArchivedViolation]
    custody: Optional[LicenseCustody]

    @property
    def original_id(self):
        return self.violation.pk if self.violation else self.archived.original_violation_id

    @property
    def date_issued(self):
        return self.violation.date_issued if self.violation else self.archived.date_issued

    @property
    def canonical(self):
        """Stable across archiving, so a replay made after the record was
        archived still matches its original fingerprint."""
        return f'{self.original_id}@{self.date_issued.isoformat()}'

    @property
    def key(self):
        return f'v{self.violation.pk}' if self.violation else f'a{self.archived.pk}'

    @property
    def doc_type_blank(self):
        if self.violation:
            return (self.violation.confiscated_document_type or '') == ''
        return (self.archived.data or {}).get('confiscated_document_type', '') in ('', None)


# ── qualification ───────────────────────────────────────────────────────────
def violation_qualifies(v):
    return v.license_status == 'confiscated' and (v.confiscated_document_type or '') in (DL, '')


def archived_qualifies(a):
    d = a.data or {}
    return d.get('license_status') == 'Confiscated' and d.get('confiscated_document_type', '') in (DL, '', None)


# ── resolution + locking ────────────────────────────────────────────────────
def _not_found():
    return CustodyError('not_found', 'Confiscated license record not found.', status=404)


def resolve_target(key):
    """Lock order: Violation -> ArchivedViolation -> LicenseCustody."""
    m = re.fullmatch(r'([va])(\d+)', key or '')
    if not m:
        raise _not_found()
    prefix, num = m.group(1), int(m.group(2))
    if prefix == 'v':
        v = Violation.objects.select_for_update().filter(pk=num).first()
        if v is not None:
            custody = LicenseCustody.objects.select_for_update().filter(violation=v).first()
            if custody is None and not violation_qualifies(v):
                raise _not_found()
            return Target('active', v, None, custody)
        # The active row was archived: an old v<id> key keeps resolving.
        custody = (LicenseCustody.objects.select_for_update()
                   .filter(original_violation_id=num, archived_violation__isnull=False)
                   .order_by('-pk').first())
        if custody is not None:
            archived = ArchivedViolation.objects.select_for_update().get(pk=custody.archived_violation_id)
            return Target('archived', None, archived, custody)
        for a in ArchivedViolation.objects.filter(original_violation_id=num).order_by('-pk'):
            if archived_qualifies(a):
                a = ArchivedViolation.objects.select_for_update().get(pk=a.pk)
                custody = LicenseCustody.objects.select_for_update().filter(archived_violation=a).first()
                return Target('archived', None, a, custody)
        raise _not_found()
    a = ArchivedViolation.objects.select_for_update().filter(pk=num).first()
    if a is None:
        raise _not_found()
    custody = LicenseCustody.objects.select_for_update().filter(archived_violation=a).first()
    if custody is None and not archived_qualifies(a):
        raise _not_found()
    return Target('archived', None, a, custody)


def _ensure_custody(target):
    if target.custody is not None:
        return target.custody
    doc = (LicenseCustody.DocTypeStatus.PENDING if target.doc_type_blank
           else LicenseCustody.DocTypeStatus.NOT_REQUIRED)
    kwargs = dict(original_violation_id=target.original_id, doc_type_status=doc, version=0)
    if target.violation:
        kwargs['violation'] = target.violation
    else:
        kwargs['archived_violation'] = target.archived
    try:
        with transaction.atomic():
            target.custody = LicenseCustody.objects.create(**kwargs)
    except IntegrityError:
        # Lost a race to create the row (the locks make this very unlikely).
        field = 'violation' if target.violation else 'archived_violation'
        target.custody = LicenseCustody.objects.select_for_update().get(
            **{field: kwargs[field]})
    return target.custody


# ── idempotency ─────────────────────────────────────────────────────────────
def fingerprint(operation, canonical_target, expected_version, fields):
    payload = {
        'operation': operation, 'target': canonical_target,
        'expected_version': expected_version, 'fields': fields,
    }
    blob = json.dumps(payload, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
    return hashlib.sha256(blob.encode('utf-8')).hexdigest()


def mask_last4(last4):
    return f'••••{last4}' if last4 else ''


# ── operations ──────────────────────────────────────────────────────────────
def _require_gate(custody):
    if custody.doc_type_status == LicenseCustody.DocTypeStatus.PENDING:
        raise CustodyError('document_type_unverified',
                           'The document type of this legacy record has not been verified yet.')
    if custody.doc_type_status == LicenseCustody.DocTypeStatus.EXCLUDED:
        raise CustodyError('record_excluded', 'This record was excluded as not a driver\'s license.')


def is_paid(target):
    """Authoritative payment state. Active: the Violation status (only
    ConfirmPaymentView can set `paid`). Archived: the snapshot's
    `settlement_status`, derived from the violation status at archive time and
    verified before the active row was deleted."""
    if target.violation is not None:
        return target.violation.status == Violation.Status.PAID
    return target.archived.settlement_status == ArchivedViolation.Settlement.SETTLED


def _require_paid(target):
    if not is_paid(target):
        raise CustodyError('payment_required',
                           'The violation must be paid before the license can be marked ready for release.')


def _op_mark_ready(actor, target, custody, f):
    if custody.status != LicenseCustody.Status.CONFISCATED:
        raise CustodyError('invalid_transition',
                           f'Cannot mark ready: the record is already {custody.get_status_display().lower()}.')
    _require_paid(target)       # server-side payment gate; payment alone never releases anything
    _require_gate(custody)
    before = custody.status
    custody.status = LicenseCustody.Status.READY
    custody.ready_marked_by = actor
    custody.ready_marked_at = timezone.now()
    return 'marked_ready', before, custody.status, {}


def _op_release(actor, target, custody, f):
    if custody.status == LicenseCustody.Status.RELEASED:
        raise CustodyError('already_released', 'This license was already released.')
    if custody.status != LicenseCustody.Status.READY:
        raise CustodyError('not_ready', 'Mark the license ready for release before releasing it.')
    _require_paid(target)
    _require_gate(custody)
    before = custody.status
    custody.status = LicenseCustody.Status.RELEASED
    custody.released_by = actor
    custody.released_at = timezone.now()
    custody.released_to_name = f['released_to_name']
    custody.claimant_id_type = f['claimant_id_type']
    custody.claimant_id_last4 = f['claimant_id_last4']
    custody.authorization_reference = f['authorization_reference']
    custody.release_remarks = f['release_remarks']
    details = {
        'released_to_name': f['released_to_name'], 'claimant_id_type': f['claimant_id_type'],
        'claimant_id_last4': f['claimant_id_last4'],
        'authorization_reference': f['authorization_reference'],
    }
    return 'released', before, custody.status, details


def _op_verify(actor, target, custody, f):
    D = LicenseCustody.DocTypeStatus
    if custody.doc_type_status != D.PENDING:
        raise CustodyError('verification_not_pending',
                           'This record does not need (or has already had) document-type verification.')
    decision = f['decision']
    if decision == 'not_drivers_license' and actor.role != 'admin':
        raise CustodyError('admin_required',
                           'Only an Administrator may exclude a record as not a driver\'s license.', status=403)
    before = custody.doc_type_status
    custody.doc_type_status = D.CONFIRMED if decision == 'drivers_license' else D.EXCLUDED
    event_type = ('document_type_confirmed' if decision == 'drivers_license'
                  else 'document_type_excluded')
    return event_type, custody.status, custody.status, {
        'reason': f['reason'], 'before': {'doc_type_status': before},
        'after': {'doc_type_status': custody.doc_type_status},
    }


def _op_correct(actor, target, custody, f):
    if actor.role != 'admin':      # defence in depth; the view already restricts to Admin
        raise CustodyError('admin_required', 'Only an Administrator may correct a license number.', status=403)
    if target.kind == 'archived':
        raise CustodyError('archived_locked',
                           'The license number of an archived record cannot be corrected.')
    before = custody.corrected_license_number or target.violation.license_number
    if f['license_number'] == before:
        # A no-op would bump the version and write a meaningless audit event.
        raise CustodyError('no_change', 'The license number is already recorded as entered.')
    custody.corrected_license_number = f['license_number']
    return 'license_number_corrected', custody.status, custody.status, {
        'reason': f['reason'], 'before': {'license_number': before},
        'after': {'license_number': f['license_number']},
    }


OPERATIONS = {
    'mark_ready': _op_mark_ready, 'release': _op_release,
    'verify_document_type': _op_verify, 'correct': _op_correct,
}
_AUDIT_TEXT = {
    'marked_ready': 'marked a confiscated license ready for release',
    'released': 'released a confiscated license',
    'document_type_confirmed': 'confirmed a legacy record as a driver\'s license',
    'document_type_excluded': 'excluded a legacy record (not a driver\'s license)',
    'license_number_corrected': 'corrected the license number of a confiscated license',
}


@dataclass
class Result:
    custody: LicenseCustody
    target: Target
    replayed: bool = False


def _run(actor, operation, key, expected_version, client_request_id, fields, request):
    with transaction.atomic():
        target = resolve_target(key)
        fp = fingerprint(operation, target.canonical, expected_version, fields)
        prior = LicenseCustodyEvent.objects.filter(
            actor=actor, client_request_id=client_request_id).select_related('custody').first()
        if prior is not None:
            if prior.request_fingerprint != fp:
                raise CustodyError('idempotency_conflict',
                                   'This client_request_id was already used for a different request.')
            custody = prior.custody
            return Result(custody, _target_for_custody(custody), replayed=True)

        custody = _ensure_custody(target)
        if custody.version != expected_version:
            raise CustodyError('version_conflict',
                               'This record was changed by someone else. Reload and try again.',
                               current_version=custody.version)
        event_type, from_s, to_s, details = OPERATIONS[operation](actor, target, custody, fields)
        custody.version += 1
        custody.save()
        try:
            with transaction.atomic():
                LicenseCustodyEvent.objects.create(
                    custody=custody, operation=operation, event_type=event_type,
                    from_status=from_s, to_status=to_s, actor=actor,
                    actor_name_snapshot=actor.full_name, actor_role_snapshot=actor.role,
                    details=details or None, request_fingerprint=fp,
                    client_request_id=client_request_id,
                )
        except IntegrityError:
            raise _IdempotencyRace()
        log_action(
            user=actor, action='UPDATE', module='Confiscated Licenses',
            description=f'{actor.full_name} {_AUDIT_TEXT[event_type]} (record {target.key})',
            request=request, target_type='LicenseCustody', target_id=custody.pk,
            changes={'status': {'before': from_s, 'after': to_s}} if from_s != to_s else None,
            details={'event_type': event_type, 'custody_id': custody.pk, 'record_key': target.key,
                     **{k: v for k, v in details.items() if k != 'reason'}},
        )
        return Result(custody, target)


def _target_for_custody(custody):
    if custody.violation_id:
        return Target('active', custody.violation, None, custody)
    return Target('archived', None, custody.archived_violation, custody)


def execute(actor, operation, key, expected_version, client_request_id, fields, request=None):
    for _ in range(2):
        try:
            return _run(actor, operation, key, expected_version, client_request_id, fields, request)
        except _IdempotencyRace:
            continue          # the winner committed; the retry replays or conflicts
    raise CustodyError('idempotency_conflict', 'Concurrent duplicate request.')