import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('violations', '0016_vehiclebrandmodel'),
    ]

    operations = [
        migrations.AddField(
            model_name='vehiclebrandmodel',
            name='vehicle_type',
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name='brand_models',
                to='violations.vehicletype',
                help_text='Vehicle type this brand/model belongs to (category is derived from this).',
            ),
        ),
    ]