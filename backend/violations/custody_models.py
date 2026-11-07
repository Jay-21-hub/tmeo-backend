"""
Confiscated Licenses custody ledger (Checkpoint 3, Stage B).

LicenseCustody       one row per physical driver's license TMEO holds. It is
                     the long-lived record: it survives the archiving of the
                     Violation it came from (the link is relinked atomically
                     from `violation` to `archived_violation`).
LicenseCustodyEvent  append-only audit ledger of every custody action.

Protection is layered:
  * database  - CHECK constraints (exactly one link, doc-type gate, status
                coherence) + triggers created in migration 0034
  * ORM       - event save()/delete() and queryset update/delete are blocked;
                custody delete is blocked
  * D3 lock   - confiscation fields on a Violation cannot change once the
                ticket is paid or a custody row exists (pre_save backstop here,
                primary guard in ViolationDetailSerializer.update)

The historical Violation row is never rewritten by custody operations.
"""
from django.conf import settings
from django.db import models
from django.db.models import Q
from django.db.models.signals import pre_save
from django.dispatch import receiver
from rest_framework.exceptions import APIException

from .models import Violation

CONFISCATION_FIELDS = (
    'license_status', 'license_number',
    'confiscated_document_type', 'confiscated_document_name',
    'confiscated_document_number',
)


class CustodyIntegrityError(Exception):
    """Raised by ORM-level guards (the database triggers are the real wall)."""


class ConfiscationLockedError(Exception):
    """pre_save backstop: confiscation fields are locked for this violation."""


class _CodedConflict(APIException):
    """409 whose body is {"code": <stable code>, "detail": <message>} - the same
    shape as every other custody error - and never a server traceback."""
    status_code = 409
    default_code = 'conflict'
    message = ''

    def __init__(self, detail=None, code=None):
        super().__init__(
            detail={'code': code or self.default_code, 'detail': detail or self.message},
            code=code or self.default_code,
        )


class ConfiscationLockedAPIError(_CodedConflict):
    default_code = 'confiscation_locked'
    message = (
        'The confiscated-license details of this record are locked because the '
        'ticket is paid or a custody record exists. Use the Confiscated Licenses '
        'module to correct them.'
    )


class CustodyProtectedAPIError(_CodedConflict):
    default_code = 'custody_protected'
    message = 'This violation has a confiscated-license custody record and cannot be deleted.'


# ── querysets / managers ────────────────────────────────────────────────────
class _AppendOnlyQuerySet(models.QuerySet):
    def _blocked(self, *a, **k):
        raise CustodyIntegrityError('License custody events are append-only.')
    update = delete = bulk_update = _raw_delete = _blocked


class _NoDeleteQuerySet(models.QuerySet):
    """Custody rows may be updated (relink, forward transitions) never deleted."""
    def _blocked(self, *a, **k):
        raise CustodyIntegrityError('License custody records cannot be deleted.')
    delete = _raw_delete = _blocked


class LicenseCustody(models.Model):
    class Status(models.TextChoices):
        CONFISCATED = 'confiscated', 'Confiscated'
        READY = 'ready_for_release', 'Pending Release'
        RELEASED = 'released', 'Released'

    class DocTypeStatus(models.TextChoices):
        NOT_REQUIRED = 'not_required', 'Not required'
        PENDING = 'pending', 'Pending verification'
        CONFIRMED = 'confirmed_drivers_license', "Confirmed driver's license"
        EXCLUDED = 'excluded', 'Excluded (not a driver\'s license)'

    class ClaimantIdType(models.TextChoices):
        DRIVERS_LICENSE = 'drivers_license', "Driver's License"
        PASSPORT = 'passport', 'Passport'
        UMID = 'umid', 'UMID'
        PHILSYS = 'philsys', 'PhilSys National ID'
        POSTAL = 'postal', 'Postal ID'
        VOTERS = 'voters', "Voter's ID"
        OTHER = 'other', 'Other'

    violation = models.OneToOneField(
        'violations.Violation', null=True, blank=True, on_delete=models.PROTECT,
        related_name='custody',
    )
    archived_violation = models.OneToOneField(
        'database_management.ArchivedViolation', null=True, blank=True,
        on_delete=models.PROTECT, related_name='custody',
    )
    original_violation_id = models.PositiveIntegerField(db_index=True)

    status = models.CharField(max_length=20, choices=Status.choices, default=Status.CONFISCATED)
    doc_type_status = models.CharField(
        max_length=30, choices=DocTypeStatus.choices, default=DocTypeStatus.NOT_REQUIRED,
    )
    version = models.PositiveIntegerField(default=0)

    # descriptive / correctable (mutable by design; changes are audited)
    corrected_license_number = models.CharField(max_length=50, blank=True, default='')

    ready_marked_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name='+',
    )
    ready_marked_at = models.DateTimeField(null=True, blank=True)

    released_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name='+',
    )
    released_at = models.DateTimeField(null=True, blank=True)
    released_to_name = models.CharField(max_length=150, blank=True, default='')
    claimant_id_type = models.CharField(max_length=20, choices=ClaimantIdType.choices, blank=True, default='')
    # Last four characters ONLY. Full ID numbers are never stored or logged.
    claimant_id_last4 = models.CharField(max_length=4, blank=True, default='')
    # A document reference (authorization letter / SPA), NOT an ID number.
    authorization_reference = models.CharField(max_length=100, blank=True, default='')
    release_remarks = models.TextField(blank=True, default='')

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    objects = _NoDeleteQuerySet.as_manager()

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=Q(violation__isnull=False, archived_violation__isnull=True)
                | Q(violation__isnull=True, archived_violation__isnull=False),
                name='custody_exactly_one_link',
            ),
            models.CheckConstraint(
                condition=Q(violation__isnull=True) | Q(violation_id=models.F('original_violation_id')),
                name='custody_active_link_matches_original',
            ),
            models.CheckConstraint(
                condition=Q(status='confiscated')
                | Q(doc_type_status__in=['not_required', 'confirmed_drivers_license']),
                name='custody_doc_type_gate',
            ),
            models.CheckConstraint(
                condition=Q(status='confiscated') | Q(ready_marked_at__isnull=False),
                name='custody_ready_requires_marker',
            ),
            models.CheckConstraint(
                condition=~Q(status='released') | (
                    Q(released_at__isnull=False, released_by__isnull=False)
                    & ~Q(released_to_name='') & ~Q(authorization_reference='')
                ),
                name='custody_released_requires_release_data',
            ),
        ]

    def delete(self, *a, **k):
        raise CustodyIntegrityError('License custody records cannot be deleted.')

    def __str__(self):
        return f'Custody #{self.pk} ({self.status})'


class LicenseCustodyEvent(models.Model):
    class Operation(models.TextChoices):
        MARK_READY = 'mark_ready', 'Mark ready for release'
        RELEASE = 'release', 'Release'
        VERIFY = 'verify_document_type', 'Verify document type'
        CORRECT = 'correct', 'Correct license number'

    custody = models.ForeignKey(LicenseCustody, on_delete=models.PROTECT, related_name='events')
    operation = models.CharField(max_length=30, choices=Operation.choices)
    event_type = models.CharField(max_length=40)
    from_status = models.CharField(max_length=20, blank=True, default='')
    to_status = models.CharField(max_length=20, blank=True, default='')
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name='+')
    actor_name_snapshot = models.CharField(max_length=150, blank=True, default='')
    actor_role_snapshot = models.CharField(max_length=20, blank=True, default='')
    # Admin-only: reasons and before/after values. Never a full ID number.
    details = models.JSONField(null=True, blank=True)
    request_fingerprint = models.CharField(max_length=64, blank=True, default='')
    client_request_id = models.UUIDField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    objects = _AppendOnlyQuerySet.as_manager()

    class Meta:
        ordering = ['created_at', 'id']
        constraints = [
            models.UniqueConstraint(
                fields=['actor', 'client_request_id'],
                condition=Q(client_request_id__isnull=False),
                name='custody_event_actor_request_unique',
            ),
        ]

    def save(self, *a, **k):
        if self.pk is not None and not self._state.adding:
            raise CustodyIntegrityError('License custody events are append-only.')
        return super().save(*a, **k)

    def delete(self, *a, **k):
        raise CustodyIntegrityError('License custody events are append-only.')


# ── D3 lock: pre_save backstop ──────────────────────────────────────────────
def _norm(v):
    return '' if v is None else str(v)


def confiscation_changes(old_values, new_values):
    """{field: (old, new)} for confiscation fields whose normalized value
    actually differs. Unchanged / absent fields never count."""
    out = {}
    for f in CONFISCATION_FIELDS:
        if f in new_values and _norm(old_values.get(f)) != _norm(new_values[f]):
            out[f] = (old_values.get(f), new_values[f])
    return out


def confiscation_is_locked(violation_pk, db_status):
    return db_status == Violation.Status.PAID or LicenseCustody.objects.filter(
        violation_id=violation_pk).exists()


@receiver(pre_save, sender=Violation, dispatch_uid='custody_confiscation_lock')
def _confiscation_lock_backstop(sender, instance, update_fields=None, **kwargs):
    if instance.pk is None or instance._state.adding:
        return
    if update_fields is not None and not (set(update_fields) & set(CONFISCATION_FIELDS)):
        return
    old = (Violation.objects.filter(pk=instance.pk)
           .values('status', *CONFISCATION_FIELDS).first())
    if old is None:
        return
    new = {f: getattr(instance, f) for f in CONFISCATION_FIELDS
           if update_fields is None or f in update_fields}
    if confiscation_changes(old, new) and confiscation_is_locked(instance.pk, old['status']):
        raise ConfiscationLockedError(
            f'Confiscation fields of violation #{instance.pk} are locked '
            '(paid ticket or custody record exists).'
        )