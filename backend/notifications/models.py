from django.db import models
from accounts.models import CustomUser
from accounts.identity import SnapshotSource, snapshot_fields


class Notification(models.Model):
    class Type(models.TextChoices):
        ENFORCER_ON_DUTY      = 'enforcer_on_duty',      'Enforcer On Duty'
        ENFORCER_OUT_OF_ZONE  = 'enforcer_out_of_zone',  'Enforcer Out of Zone'
        ENFORCER_IN_ZONE      = 'enforcer_in_zone',      'Enforcer In Zone'
        NEW_VIOLATION         = 'new_violation',         'New Violation Submitted'
        VIOLATION_PAID        = 'violation_paid',        'Violation Paid'
        PENDING_TOO_LONG      = 'pending_too_long',      'Pending Too Long'
        # Personal (per-enforcer) schedule notifications - recipient_user is set.
        DUTY_ASSIGNED         = 'duty_assigned',         'Duty Assigned'
        DUTY_UPDATED          = 'duty_updated',          'Duty Updated'
        DUTY_REMOVED          = 'duty_removed',          'Duty Removed'

    class Target(models.TextChoices):
        ADMIN    = 'admin',    'Admin'
        STAFF    = 'staff',    'Staff'
        ENFORCER = 'enforcer', 'Enforcer'

    recipient_role = models.CharField(max_length=20, choices=Target.choices)
    # NULL  -> role broadcast (every user holding recipient_role sees it, and
    #          read state is shared by that role: the original behaviour).
    # set   -> personal: ONLY this account (stable CustomUser.pk, never the
    #          ID number) sees it and owns its read state. recipient_role is
    #          still stored (the role at event time) but is not a visibility gate.
    # Distinct from related_user, which is the ACTOR and is audit-only.
    recipient_user = models.ForeignKey(
        CustomUser, on_delete=models.PROTECT,
        null=True, blank=True, related_name='received_notifications',
        db_index=True,
    )
    notif_type     = models.CharField(max_length=50, choices=Type.choices)
    title          = models.CharField(max_length=200)
    message        = models.TextField()
    is_read        = models.BooleanField(default=False)
    related_user   = models.ForeignKey(
        CustomUser, on_delete=models.PROTECT,
        null=True, blank=True, related_name='triggered_notifications'
    )
    related_violation_id = models.CharField(max_length=20, blank=True)

    # Event-time identity of the actor (related_user) — Role Evolution, Phase 1.
    # related_user stays the stable FK; these freeze name/role/ID as they were
    # when the notification was raised. NULL + 'unknown' on legacy rows.
    actor_name_snapshot = models.CharField(max_length=150, null=True, blank=True, editable=False)
    actor_role_snapshot = models.CharField(
        max_length=20, choices=CustomUser.Role.choices, null=True, blank=True, editable=False,
    )
    actor_id_number_snapshot = models.CharField(max_length=50, null=True, blank=True, editable=False)
    actor_snapshot_source = models.CharField(
        max_length=10, choices=SnapshotSource.choices, default=SnapshotSource.UNKNOWN, editable=False,
    )
    created_at     = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = 'notifications'
        ordering = ['-created_at']

    def save(self, *args, **kwargs):
        # Event-time actor snapshot (Role Evolution, Phase 2): the single
        # central capture point for every Notification creation path. Runs
        # only when the row is first created and only while no snapshot has
        # been set, so later saves (e.g. marking as read) can never rewrite
        # history. Values come from the server-side related_user, never from
        # client input; no related_user -> stays 'unknown'.
        if self._state.adding and self.related_user_id and \
                self.actor_snapshot_source == SnapshotSource.UNKNOWN:
            for field, value in snapshot_fields(self.related_user, 'actor').items():
                setattr(self, field, value)
            update_fields = kwargs.get('update_fields')
            if update_fields is not None:
                kwargs['update_fields'] = set(update_fields) | {
                    'actor_name_snapshot', 'actor_role_snapshot',
                    'actor_id_number_snapshot', 'actor_snapshot_source',
                }
        super().save(*args, **kwargs)

    def __str__(self):
        return f'[{self.recipient_role}] {self.title}'