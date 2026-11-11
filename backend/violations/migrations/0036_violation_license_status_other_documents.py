from django.db import migrations, models


class Migration(migrations.Migration):
    """Adds the 'Other Documents' choice to Violation.license_status.

    Choices-only change: the column (varchar(20)) is unchanged, so this runs
    no DDL on PostgreSQL. 'other_documents' means TMEO only recorded the
    violator's information from a valid ID; nothing is held in custody.
    """

    dependencies = [
        ('violations', '0035_violationtype_vehicle_category'),
    ]

    operations = [
        migrations.AlterField(
            model_name='violation',
            name='license_status',
            field=models.CharField(
                choices=[
                    ('confiscated', 'Confiscated'),
                    ('not_confiscated', 'Not Confiscated'),
                    ('other_documents', 'Other Documents'),
                ],
                default='not_confiscated',
                max_length=20,
            ),
        ),
    ]