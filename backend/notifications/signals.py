from django.db.models.signals import post_save, pre_save
from django.dispatch import receiver
from violations.models import Violation
from enforcers.models import EnforcerLocation
from .models import Notification


@receiver(pre_save, sender=Violation)
def stash_previous_violation_status(sender, instance, **kwargs):
    """Capture the violation's status as currently stored in the DB (before this
    save lands), so the post_save handler can tell whether status actually
    *changed* to 'paid' vs. was already 'paid' and got saved again for some
    unrelated edit."""
    if instance.pk:
        instance._previous_status = (
            Violation.objects.filter(pk=instance.pk)
            .values_list('status', flat=True)
            .first()
        )
    else:
        instance._previous_status = None


@receiver(post_save, sender=Violation)
def violation_notification(sender, instance, created, **kwargs):
    # Intentionally creates nothing.
    #  - New-violation notifications are created in
    #    ViolationCreateView.perform_create() AFTER items are saved, with the
    #    real submitter and role.
    #  - 'Violation Paid' is created ONLY by ConfirmPaymentView, which knows
    #    the authenticated actor and the persisted amount_paid. (This signal
    #    used to create a second, actor-less paid notification using the
    #    ticket penalty_amount.)
    return


@receiver(post_save, sender=EnforcerLocation)
def enforcer_location_notification(sender, instance, created, **kwargs):
    # Intentionally creates nothing.
    #  The first-ever EnforcerLocation row used to announce "has started duty"
    #  regardless of schedule. "Started duty" is now created only by
    #  enforcers.duty.notify_started_duty(), called from UpdateLocationView when
    #  the server-computed state is actually on_duty (once per enforcer per
    #  local day), so it can never fire for no-schedule / before-shift /
    #  after-shift / break states.
    return