from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('enforcers', '0004_remove_enforcerschedule_shift_type'),
    ]

    operations = [
        migrations.AddField(
            model_name='enforcerlocation',
            name='geofence_outside_since',
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='enforcerlocation',
            name='geofence_last_alert_at',
            field=models.DateTimeField(blank=True, null=True),
        ),
    ]