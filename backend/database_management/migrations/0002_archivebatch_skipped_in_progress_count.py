from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('database_management', '0001_initial'),
    ]

    operations = [
        migrations.AddField(
            model_name='archivebatch',
            name='skipped_in_progress_count',
            field=models.PositiveIntegerField(default=0),
        ),
    ]