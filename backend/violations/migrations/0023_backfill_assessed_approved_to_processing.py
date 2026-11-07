# Generated manually on 2026-09-21

"""
Why this migration exists
--------------------------
The Violation.status workflow is being simplified from 5 states
(pending, processing, assessed, approved, paid) down to 3
(pending, processing, paid) — 'assessed' and 'approved' were never a
separate workload for Staff; they were just intermediate steps on the
way to 'paid', and the "Mark as Paid" action now does the assessment +
ticket generation + payment in a single step.

Any EXISTING row still sitting in 'assessed' or 'approved' (e.g. from
the old "Approve & Generate Ticket" action) is converted to
'processing' here, BEFORE the next migration removes those choices
from the model. Without this step those rows would keep an
out-of-choices value forever, and — worse — would silently vanish
from every Staff queue/filter that only knows about the new 3-status
set (they're neither 'pending'/'processing' nor 'paid').

Reversible: the reverse migration cannot know which 'processing' rows
used to be 'assessed' vs 'approved' vs genuinely 'processing', so it
is intentionally a no-op. This is a one-way data cleanup, consistent
with how the rest of this app's status-shrinking migrations behave.
"""

from django.db import migrations


def forwards(apps, schema_editor):
    Violation = apps.get_model('violations', 'Violation')
    Violation.objects.filter(status__in=['assessed', 'approved']).update(status='processing')


def backwards(apps, schema_editor):
    # Intentional no-op — see module docstring above.
    pass


class Migration(migrations.Migration):

    dependencies = [
        ('violations', '0022_bigautofield_assessment_evidence_pk'),
    ]

    operations = [
        migrations.RunPython(forwards, backwards),
    ]