# Generated manually for Requirement #10 (Offline Mode, Session Persistence & Sync Lifecycle)

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('violations', '0024_simplify_status_choices'),
    ]

    operations = [
        migrations.AddField(
            model_name='violation',
            name='client_offline_id',
            field=models.CharField(
                blank=True, db_index=True, help_text='Client-generated idempotency key for offline-queued OVR submissions.',
                max_length=100, null=True, unique=True,
            ),
        ),
    ]