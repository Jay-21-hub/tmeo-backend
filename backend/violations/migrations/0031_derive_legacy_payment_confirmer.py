"""
Conservative legacy derivation for Assessment payment-confirmer / assessor
snapshots (Role Evolution, Phase 2).

Background: before Phase 2, ConfirmPaymentView overwrote Assessment.assessed_by
and Violation.assessed_by with the user who confirmed payment, so on historical
paid rows those FKs do NOT reliably identify the assessor.

The only reliable evidence is the AuditLog row each action wrote at the time.
Its structured `details` JSON recorded the acting user's name and role then
(keys 'event', 'assessed_by', 'role') — no free-text parsing is involved.

PAYMENT CONFIRMER  (paid Assessment, nothing recorded yet)
  Exactly one AuditLog with module='Payment', target Violation <id> and
  details.event == 'PAYMENT_CONFIRMED' -> derive:
      payment_confirmed_by           = that log's user (may be NULL)
      payment_confirmed_at           = that log's timestamp
      payment_confirmer_name_snapshot= details['assessed_by']  (name at the time)
      payment_confirmer_role_snapshot= details['role']         (role at the time)
      payment_confirmer_snapshot_source = 'derived'
  id_number is NOT in the evidence -> stays NULL.
  Zero or several such logs -> untouched (source stays 'unknown').

ASSESSOR  (paid Assessment with assessed_by set, nothing recorded yet)
  Take the latest AuditLog with module='Assessment', action='UPDATE', target
  Violation <id>, at or before the payment event (or any, when there is no
  derived payment event). Only if that log's user IS the current
  Assessment.assessed_by is the snapshot derived from its details (name/role
  at the time, source='derived'). If they differ, payment confirmation
  overwrote the FK and the true assessor cannot be proven: left 'unknown'.

NEVER done here: no assessed_by FK is rewritten, no snapshot is copied from
a user's CURRENT name / role / ID, nothing is marked 'event', no row is
created, no user is touched. Ambiguous rows stay 'unknown'.
"""
from django.db import migrations

VALID_ROLES = {'admin', 'staff', 'enforcer'}


def _role(value):
    value = str(value).strip().lower() if value is not None else None
    return value if value in VALID_ROLES else None


def _name(value):
    value = (value or '').strip() if isinstance(value, str) else ''
    return value[:150] or None


def derive(apps, schema_editor):
    Assessment = apps.get_model('violations', 'Assessment')
    AuditLog = apps.get_model('audit', 'AuditLog')

    pay_logs, assess_logs = {}, {}
    for log in AuditLog.objects.filter(
        target_type='Violation', module__in=['Payment', 'Assessment'],
    ).order_by('timestamp', 'id').iterator():
        details = log.details if isinstance(log.details, dict) else {}
        if log.module == 'Payment' and details.get('event') == 'PAYMENT_CONFIRMED':
            pay_logs.setdefault(log.target_id, []).append(log)
        elif log.module == 'Assessment' and log.action == 'UPDATE':
            assess_logs.setdefault(log.target_id, []).append(log)

    qs = Assessment.objects.filter(violation__status='paid').select_related('violation')
    for a in qs.iterator():
        key = str(a.violation_id)
        changed = []
        paid_log = None

        confirmers = pay_logs.get(key, [])
        if (a.payment_confirmer_snapshot_source == 'unknown'
                and a.payment_confirmed_by_id is None
                and a.payment_confirmed_at is None
                and len(confirmers) == 1):
            paid_log = confirmers[0]
            d = paid_log.details
            a.payment_confirmed_by_id = paid_log.user_id
            a.payment_confirmed_at = paid_log.timestamp
            a.payment_confirmer_name_snapshot = _name(d.get('assessed_by'))
            a.payment_confirmer_role_snapshot = _role(d.get('role'))
            a.payment_confirmer_snapshot_source = 'derived'
            changed += ['payment_confirmed_by', 'payment_confirmed_at',
                        'payment_confirmer_name_snapshot', 'payment_confirmer_role_snapshot',
                        'payment_confirmer_snapshot_source']
        elif len(confirmers) == 1:
            paid_log = confirmers[0]

        if a.assessor_snapshot_source == 'unknown' and a.assessed_by_id is not None:
            candidates = assess_logs.get(key, [])
            if paid_log is not None:
                candidates = [c for c in candidates if c.timestamp <= paid_log.timestamp]
            last = candidates[-1] if candidates else None
            if last is not None and last.user_id == a.assessed_by_id:
                d = last.details if isinstance(last.details, dict) else {}
                name, role = _name(d.get('assessed_by')), _role(d.get('role'))
                if name or role:
                    a.assessor_name_snapshot = name
                    a.assessor_role_snapshot = role
                    a.assessor_snapshot_source = 'derived'
                    changed += ['assessor_name_snapshot', 'assessor_role_snapshot',
                                'assessor_snapshot_source']

        if changed:
            # Queryset.update(): does not bump updated_at and fires no signals.
            Assessment.objects.filter(pk=a.pk).update(**{f: getattr(a, f) for f in changed})


def undo(apps, schema_editor):
    Assessment = apps.get_model('violations', 'Assessment')
    (Assessment.objects.filter(payment_confirmer_snapshot_source='derived').update(
        payment_confirmed_by=None, payment_confirmed_at=None,
        payment_confirmer_name_snapshot=None, payment_confirmer_role_snapshot=None,
        payment_confirmer_snapshot_source='unknown'))
    (Assessment.objects.filter(assessor_snapshot_source='derived').update(
        assessor_name_snapshot=None, assessor_role_snapshot=None,
        assessor_snapshot_source='unknown'))


class Migration(migrations.Migration):

    dependencies = [
        ('audit', '0006_auditlog_actor_snapshot'),
        ('violations', '0030_assessment_payment_confirmer'),
    ]

    operations = [
        migrations.RunPython(derive, undo),
    ]