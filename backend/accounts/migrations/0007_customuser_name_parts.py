# Adds separate last_name/first_name/middle_name fields for the Edit User
# form, and best-effort backfills first_name/last_name for existing rows
# from their current full_name. This is purely to pre-fill the Edit form
# for legacy users — it never touches the original full_name column, so no
# existing user's displayed name changes as a result of this migration.

from django.db import migrations, models


def backfill_name_parts(apps, schema_editor):
    CustomUser = apps.get_model('accounts', 'CustomUser')
    for user in CustomUser.objects.all():
        full_name = (user.full_name or '').strip()
        if not full_name:
            continue

        # full_name is stored as "Last, First Middle" when created through
        # the split form, but legacy rows may be free-text ("First Last" or
        # a single name). Handle both shapes on a best-effort basis:
        if ',' in full_name:
            last_part, given_part = full_name.split(',', 1)
            last_name = last_part.strip()
            given_tokens = given_part.strip().split()
        else:
            tokens = full_name.split()
            if len(tokens) >= 2:
                last_name = tokens[-1]
                given_tokens = tokens[:-1]
            else:
                last_name = ''
                given_tokens = tokens

        first_name  = given_tokens[0] if given_tokens else ''
        middle_name = ' '.join(given_tokens[1:]) if len(given_tokens) > 1 else ''

        user.last_name   = last_name
        user.first_name  = first_name
        user.middle_name = middle_name
        user.save(update_fields=['last_name', 'first_name', 'middle_name'])


def noop_reverse(apps, schema_editor):
    # Reversing only needs to be safe, not to restore anything — the
    # original full_name was never touched by this migration.
    pass


class Migration(migrations.Migration):

    dependencies = [
        ('accounts', '0006_customuser_profile_photo'),
    ]

    operations = [
        migrations.AddField(
            model_name='customuser',
            name='last_name',
            field=models.CharField(blank=True, max_length=100),
        ),
        migrations.AddField(
            model_name='customuser',
            name='first_name',
            field=models.CharField(blank=True, max_length=100),
        ),
        migrations.AddField(
            model_name='customuser',
            name='middle_name',
            field=models.CharField(blank=True, max_length=100),
        ),
        migrations.RunPython(backfill_name_parts, noop_reverse),
    ]