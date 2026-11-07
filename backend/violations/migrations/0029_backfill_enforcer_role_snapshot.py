"""
Conservative legacy backfill for Violation.enforcer_*_snapshot (Role Evolution, Phase 1).

What is filled, and why only this:

  enforcer_role_snapshot = 'enforcer'   enforcer_snapshot_source = 'assumed'

  for rows where ALL of the following hold:
    - source == 'enforcer_ovr' (the Enforcer OVR flow)
    - an enforcer FK exists
    - that account's role today is 'enforcer'
    - the row has no snapshot yet (source still 'unknown')

Why 'assumed', not 'derived': no code path in the app changes a user's role
and there is no role-history ledger yet, so today's role is very likely the
role at the time. But Django Admin could always edit a role, and before
Batch 0 a Staff/Admin token could file an 'enforcer_ovr' row, so it is not
a guarantee. We therefore mark it 'assumed'.

What is deliberately NOT filled (left NULL, source 'unknown'):
  - enforcer_name_snapshot / enforcer_id_number_snapshot / enforcer_badge_snapshot
    Copying today's name / ID would assert event-time truth we cannot prove
    (the name or ID may change later; D3). Once real role changes exist, the
    UserRoleHistory ledger lets the old ID be derived for events before a
    transition's effective_at.
  - rows with no enforcer FK (imports, staff walk-ins, deleted users)
  - rows whose enforcer is not an Enforcer today
  - every Assessment.assessor_* (assessed_by can be overwritten by payment
    confirmation, so it does not reliably identify the assessor)

QuerySet.update() is used on purpose: it does not touch updated_at, and no
user account is read for write or modified.
"""
from django.db import migrations


def backfill(apps, schema_editor):
    Violation = apps.get_model('violations', 'Violation')
    (Violation.objects
        .filter(
            source='enforcer_ovr',
            enforcer__isnull=False,
            enforcer__role='enforcer',
            enforcer_snapshot_source='unknown',
            enforcer_role_snapshot__isnull=True,
        )
        .update(enforcer_role_snapshot='enforcer', enforcer_snapshot_source='assumed'))


def undo(apps, schema_editor):
    Violation = apps.get_model('violations', 'Violation')
    (Violation.objects
        .filter(enforcer_snapshot_source='assumed', enforcer_name_snapshot__isnull=True,
                enforcer_id_number_snapshot__isnull=True)
        .update(enforcer_role_snapshot=None, enforcer_snapshot_source='unknown'))


class Migration(migrations.Migration):

    dependencies = [
        ('accounts', '0007_customuser_name_parts'),
        ('violations', '0028_identity_snapshots'),
    ]

    operations = [
        migrations.RunPython(backfill, undo),
    ]