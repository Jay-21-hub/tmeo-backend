import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ('violations', '0017_vehiclebrandmodel_vehicle_type'),
    ]

    operations = [
        migrations.AddField(
            model_name='violation',
            name='source',
            field=models.CharField(
                choices=[
                    ('enforcer_ovr', 'Enforcer-Issued OVR'),
                    ('staff_walk_in', 'Staff Walk-in Complaint'),
                ],
                default='enforcer_ovr',
                max_length=20,
                help_text='How this record was created: Enforcer OVR vs Staff walk-in.',
            ),
        ),
        migrations.CreateModel(
            name='Assessment',
            fields=[
                ('id', models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('or_number', models.CharField(blank=True, max_length=50)),
                ('penalty', models.DecimalField(blank=True, decimal_places=2, max_digits=10, null=True)),
                ('amount_paid', models.DecimalField(blank=True, decimal_places=2, max_digits=10, null=True)),
                ('received_by', models.CharField(blank=True, max_length=150)),
                ('date_paid', models.DateField(blank=True, null=True)),
                ('assessed_at', models.DateTimeField(blank=True, null=True)),
                ('notes', models.TextField(blank=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('assessed_by', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='assessments_made', to=settings.AUTH_USER_MODEL)),
                ('violation', models.OneToOneField(on_delete=django.db.models.deletion.CASCADE, related_name='assessment', to='violations.violation')),
            ],
            options={
                'ordering': ['-created_at'],
            },
        ),
        migrations.CreateModel(
            name='ViolationEvidence',
            fields=[
                ('id', models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('image', models.ImageField(upload_to='evidence/')),
                ('captured_at', models.DateTimeField(help_text='Timestamp from the device at the moment of capture.')),
                ('server_received_at', models.DateTimeField(auto_now_add=True, help_text='When this evidence reached the backend.')),
                ('latitude', models.FloatField(blank=True, null=True)),
                ('longitude', models.FloatField(blank=True, null=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('captured_by', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='evidence_captured', to=settings.AUTH_USER_MODEL)),
                ('violation', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='evidence', to='violations.violation')),
            ],
            options={
                'ordering': ['-captured_at'],
            },
        ),
    ]