from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('violations', '0018_violation_source_assessment_violationevidence'),
    ]

    operations = [
        migrations.AddField(
            model_name='violation',
            name='vehicle_use',
            field=models.CharField(
                blank=True,
                choices=[('private', 'Private'), ('public', 'Public')],
                help_text='Private or Public use, as checked on the printed OVR.',
                max_length=10,
            ),
        ),
    ]