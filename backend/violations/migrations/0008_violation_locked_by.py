from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ('violations', '0007_alter_violation_status'),
    ]

    operations = [
        migrations.AddField(
            model_name='violation',
            name='locked_by',
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name='violations_locked',
                to=settings.AUTH_USER_MODEL,
                help_text='Staff member currently assessing this violation',
            ),
        ),
    ]