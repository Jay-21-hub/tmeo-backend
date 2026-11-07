from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('violations', '0009_violation_coordinates'),
    ]

    operations = [
        migrations.AddField(
            model_name='violation',
            name='is_printed',
            field=models.BooleanField(default=False),
        ),
    ]