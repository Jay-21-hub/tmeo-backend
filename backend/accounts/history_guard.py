"""
Historical data protection (Role Evolution, Phase 4 - policy HD-B).

An account that is the stable subject of historical TMEO records must not be
permanently deleted. `get_user_historical_references(user)` is the single,
server-side answer to "does this account have history?". Deactivation does
not depend on it and is never blocked by it.

What counts as history is decided ONLY from stable identity evidence:

  * real foreign keys to the account (authored / attributed records), and
  * for archived records (which carry no user FK), the stable person id
    (`enforcer_user_id`) or an ID-number snapshot that equals an ID the
    account holds or ever held (current id_number + UserRoleHistory ledger).

Names are never used: they are not stable identity keys (they can be
duplicated, renamed or misspelled). An archived record that only has a name
is preserved but is NOT attached to any current account.

Deliberately NOT history:
  * Violation.locked_by - transient assessment lock (SET_NULL).
  * EnforcerLocation    - live GPS state updated in place (CASCADE).
  * Text mentions of the account inside another record's details/target_id
    (e.g. the Admin's "account created" audit row): not authored by it.

Database PROTECT on the historical foreign keys remains the final safety
net if a relationship is ever missed here.
"""
from django.contrib.admin.models import LogEntry
from django.db.models import Q


# (key, label shown to the administrator). Labels are plain language on
# purpose: no table names or implementation details leave the server.
_LABELS = {
    'audit_trail':          'audit trail entries performed by this account',
    'admin_site_activity':  'Django admin activity entries',
    'violations_filed':     'violation records filed by this account',
    'violations_assessed':  'violation records assessed by this account',
    'violations_imported':  'violation records imported by this account',
    'assessments':          'assessments made by this account',
    'payment_confirmations': 'payment confirmations made by this account',
    'evidence':             'evidence captured by this account',
    'notifications':        'notifications raised by this account',
    'notifications_received': 'notifications addressed to this account',
    'archive_batches':      'database archive runs performed by this account',
    'schedules':            'enforcer schedules for this account',
    'schedules_created':    'enforcer schedules created by this account',
    'role_history':         'role / ID transition history of this account',
    'role_changes_made':    'role / ID transitions performed by this account',
    'archived_violations':  'archived violation records attributed to this account',
    'license_custody':      'confiscated license custody actions performed by this account',
}


def _held_id_numbers(user):
    """Every ID the account currently holds or ever held (never name-based)."""
    from .models import UserRoleHistory
    ids = {user.id_number} if user.id_number else set()
    for row in UserRoleHistory.objects.filter(user_id=user.pk).values('old_id_number', 'new_id_number'):
        ids.update(v for v in (row['old_id_number'], row['new_id_number']) if v)
    return ids


def _has_archived_history(user):
    """True only on stable identity evidence inside archived snapshots."""
    from database_management.models import ArchivedViolation
    qs = ArchivedViolation.objects
    if qs.filter(data__enforcer_user_id=user.pk).exists():
        return True
    ids = sorted(_held_id_numbers(user))
    if not ids:
        return False
    return (
        qs.filter(data__enforcer_id_number_snapshot__in=ids).exists()
        or qs.filter(data__assessment__assessor_id_number_snapshot__in=ids).exists()
        or qs.filter(data__assessment__payment_confirmer_id_number_snapshot__in=ids).exists()
    )


def get_user_historical_references(user):
    """
    Returns {'has_history': bool, 'categories': [key, ...], 'labels': [text, ...]}.
    `categories` are stable machine keys; `labels` are safe user-facing text.
    """
    # Imported lazily: this module is imported by accounts.views and must not
    # create import cycles with the apps that point back at accounts.
    from audit.models import AuditLog
    from violations.models import Violation, Assessment, ViolationEvidence
    from violations.custody_models import LicenseCustody, LicenseCustodyEvent
    from notifications.models import Notification
    from database_management.models import ArchiveBatch
    from enforcers.models import EnforcerSchedule
    from .models import UserRoleHistory

    pk = user.pk
    checks = [
        ('audit_trail',           AuditLog.objects.filter(user_id=pk)),
        ('admin_site_activity',   LogEntry.objects.filter(user_id=pk)),
        ('violations_filed',      Violation.objects.filter(enforcer_id=pk)),
        ('violations_assessed',   Violation.objects.filter(assessed_by_id=pk)),
        ('violations_imported',   Violation.objects.filter(imported_by_id=pk)),
        ('assessments',           Assessment.objects.filter(assessed_by_id=pk)),
        ('payment_confirmations', Assessment.objects.filter(payment_confirmed_by_id=pk)),
        ('evidence',              ViolationEvidence.objects.filter(captured_by_id=pk)),
        ('notifications',         Notification.objects.filter(related_user_id=pk)),
        ('notifications_received', Notification.objects.filter(recipient_user_id=pk)),
        ('archive_batches',       ArchiveBatch.objects.filter(created_by_id=pk)),
        ('schedules',             EnforcerSchedule.objects.filter(enforcer_id=pk)),
        ('schedules_created',     EnforcerSchedule.objects.filter(created_by_id=pk)),
        ('role_history',          UserRoleHistory.objects.filter(user_id=pk)),
        ('role_changes_made',     UserRoleHistory.objects.filter(changed_by_id=pk)),
    ]
    # Custody ledger: events authored, and ready/release actors on custody rows.
    custody_hit = (
        LicenseCustodyEvent.objects.filter(actor_id=pk).exists()
        or LicenseCustody.objects.filter(Q(ready_marked_by_id=pk) | Q(released_by_id=pk)).exists()
    )
    categories = [key for key, qs in checks if qs.exists()]
    if custody_hit:
        categories.append('license_custody')
    if _has_archived_history(user):
        categories.append('archived_violations')

    return {
        'has_history': bool(categories),
        'categories':  categories,
        'labels':      [_LABELS[c] for c in categories],
    }


HISTORY_BLOCK_MESSAGE = (
    'This account has historical system records and cannot be permanently '
    'deleted. Deactivate the account instead.'
)