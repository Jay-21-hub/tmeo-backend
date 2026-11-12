import datetime

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


def seed_current_fines(apps, schema_editor):
    """One baseline row per existing violation type: its current fine, in
    force since forever. Nothing about existing violations changes."""
    ViolationType = apps.get_model('violations', 'ViolationType')
    ViolationTypeFine = apps.get_model('violations', 'ViolationTypeFine')
    epoch = datetime.datetime(2000, 1, 1, tzinfo=datetime.timezone.utc)
    ViolationTypeFine.objects.bulk_create([
        ViolationTypeFine(violation_type_id=vt.id, penalty_amount=vt.penalty_amount, effective_from=epoch)
        for vt in ViolationType.objects.all()
    ])


class Migration(migrations.Migration):

    dependencies = [
        ('violations', '0036_violation_license_status_other_documents'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name='ViolationTypeFine',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('penalty_amount', models.DecimalField(decimal_places=2, max_digits=10)),
                ('effective_from', models.DateTimeField(db_index=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('changed_by', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='+', to=settings.AUTH_USER_MODEL)),
                ('violation_type', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='fine_history', to='violations.violationtype')),
            ],
            options={
                'ordering': ['-effective_from', '-id'],
            },
        ),
        migrations.RunPython(seed_current_fines, migrations.RunPython.noop),
    ]
