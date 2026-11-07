from django.db import migrations, models


def backfill_category(apps, schema_editor):
    """Copy each brand/model's linked VehicleType.category onto the new
    `category` field before the old vehicle_type FK is dropped. Rows with
    no linked type (never assigned) keep the model default ('car')."""
    VehicleBrandModel = apps.get_model('violations', 'VehicleBrandModel')
    for bm in VehicleBrandModel.objects.select_related('vehicle_type').all():
        if bm.vehicle_type_id:
            bm.category = bm.vehicle_type.category
            bm.save(update_fields=['category'])


def noop_reverse(apps, schema_editor):
    """Nothing to restore — the old vehicle_type FK values are gone once
    this migration is rolled forward; a reverse migrate just leaves every
    row's (re-created) vehicle_type FK as null, same as an unassigned row
    used to look like."""
    pass


class Migration(migrations.Migration):

    dependencies = [
        ('violations', '0020_evidence_optional_violation'),
    ]

    operations = [
        migrations.AddField(
            model_name='vehiclebrandmodel',
            name='category',
            field=models.CharField(
                choices=[
                    ('motorcycle', 'Motorcycles'),
                    ('car', 'Cars'),
                    ('puv', 'Public Utility Vehicles'),
                    ('truck', 'Trucks & Heavy Vehicles'),
                    ('special', 'Special / Other'),
                ],
                default='car',
                max_length=20,
            ),
        ),
        migrations.RunPython(backfill_category, noop_reverse),
        migrations.RemoveField(
            model_name='vehiclebrandmodel',
            name='vehicle_type',
        ),
        migrations.DeleteModel(
            name='VehicleType',
        ),
    ]