from django.db import migrations, models


class Migration(migrations.Migration):
    """Additive only: three blank-safe columns. Existing rows stay valid
    (empty string defaults); license_status and license_number untouched."""

    dependencies = [
        ('violations', '0026_violation_import_provenance'),
    ]

    operations = [
        migrations.AddField(
            model_name='violation',
            name='confiscated_document_type',
            field=models.CharField(
                blank=True, default='', max_length=20,
                choices=[
                    ('drivers_license', "Driver's License"),
                    ('bir', 'BIR-related ID/document'),
                    ('umid', 'UMID'),
                    ('company_id', 'Company ID'),
                    ('philhealth', 'PhilHealth ID'),
                    ('others', 'Others'),
                ],
            ),
        ),
        migrations.AddField(
            model_name='violation',
            name='confiscated_document_name',
            field=models.CharField(
                blank=True, default='', max_length=100,
                help_text='Custom document name — required when the type is Others.',
            ),
        ),
        migrations.AddField(
            model_name='violation',
            name='confiscated_document_number',
            field=models.CharField(
                blank=True, default='', max_length=50,
                help_text='Document / Reference Number for non-license documents.',
            ),
        ),
    ]