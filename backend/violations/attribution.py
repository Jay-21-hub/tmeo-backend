"""
Assessment attribution (Role Evolution, Phase 2).

Two different people can be involved in settling one violation:

  ASSESSOR            the Staff/Admin user who performed the assessment —
                      established when they PATCH /violations/<id>/assess/.
                      Stored on Assessment.assessed_by (+ assessor_* snapshots)
                      and mirrored on Violation.assessed_by / assessed_at.

  PAYMENT CONFIRMER   the authorised user who pressed Confirm Payment —
                      established by ConfirmPaymentView only. Stored on
                      Assessment.payment_confirmed_by (+ payment_confirmer_*
                      snapshots) and Assessment.payment_confirmed_at.

They may be the same person, but only because that person performed both
events. Confirming payment never touches the assessor fields.

Every value is taken from the server-side user object through
accounts.identity.snapshot_fields — nothing here reads client input.
"""
from django.db import transaction
from django.utils import timezone

from accounts.identity import snapshot_fields

from .models import Assessment


def record_assessor(violation, user, *, when=None):
    """Establish `user` as the assessor of `violation` at this moment.

    Writes, in one transaction:
      Violation.assessed_by / assessed_at           (denormalised mirror)
      Assessment.assessed_by / assessed_at          (authoritative record)
      Assessment.assessor_*_snapshot, source=event  (identity right now)

    The Assessment row is created if it does not exist yet (it is already
    created lazily by AssessmentDetailView; this just does it at the event).
    Saves the violation itself, so callers need not.
    """
    when = when or timezone.now()
    with transaction.atomic():
        violation.assessed_by = user
        violation.assessed_at = when
        violation.save()

        assessment, _ = Assessment.objects.get_or_create(violation=violation)
        assessment.assessed_by = user
        assessment.assessed_at = when
        for field, value in snapshot_fields(user, 'assessor').items():
            setattr(assessment, field, value)
        assessment.save()
    return assessment


def record_payment_confirmer(assessment, user, *, when):
    """Set the payment confirmer on `assessment` (does not save).

    Deliberately never touches assessed_by / assessed_at / assessor_*.
    """
    assessment.payment_confirmed_by = user
    assessment.payment_confirmed_at = when
    for field, value in snapshot_fields(user, 'payment_confirmer').items():
        setattr(assessment, field, value)