from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('enforcers', '0002_enforcerschedule'),
    ]

    operations = [
        migrations.AddField(
            model_name='enforcerschedule',
            name='break_start',
            field=models.TimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='enforcerschedule',
            name='break_end',
            field=models.TimeField(blank=True, null=True),
        ),
    ]