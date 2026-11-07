from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('audit', '0002_auditlog_status'),
    ]

    operations = [
        migrations.AddField(
            model_name='auditlog',
            name='details',
            field=models.JSONField(null=True, blank=True),
        ),
    ]