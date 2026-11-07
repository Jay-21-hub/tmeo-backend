from django.db import migrations, models


class Migration(migrations.Migration):
    """
    Re-adds latitude and longitude fields to the Violation model.
    These were present in the initial migration but removed from models.py.
    They are required for the GIS heatmap feature.
    """

    dependencies = [
        ('violations', '0008_violation_locked_by'),
    ]

    operations = [
        migrations.AddField(
            model_name='violation',
            name='latitude',
            field=models.FloatField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='violation',
            name='longitude',
            field=models.FloatField(blank=True, null=True),
        ),
    ]