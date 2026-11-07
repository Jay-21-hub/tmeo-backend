from django.db import migrations


def backfill_snapshots(apps, schema_editor):
    ViolationItem = apps.get_model('violations', 'ViolationItem')
    for item in ViolationItem.objects.select_related('violation_type').all():
        item.penalty_amount_snapshot = item.violation_type.penalty_amount
        item.save(update_fields=['penalty_amount_snapshot'])


def reverse_backfill(apps, schema_editor):
    # No-op — reversing this migration just leaves the snapshot values as-is.
    pass


class Migration(migrations.Migration):

    dependencies = [
        ('violations', '0012_violationitem_penalty_amount_snapshot'),
    ]

    operations = [
        migrations.RunPython(backfill_snapshots, reverse_backfill),
    ]