from django.db import models
from accounts.models import CustomUser


class EnforcerLocation(models.Model):

    class StatusChoices(models.TextChoices):
        ACTIVE   = 'active',   'Active'
        ON_BREAK = 'on_break', 'On Break'
        INACTIVE = 'inactive', 'Inactive'

    enforcer  = models.OneToOneField(
        CustomUser, on_delete=models.CASCADE, related_name='location'
    )
    latitude  = models.FloatField()
    longitude = models.FloatField()
    status    = models.CharField(
        max_length=20,
        choices=StatusChoices.choices,
        default=StatusChoices.ACTIVE
    )
    updated_at = models.DateTimeField(auto_now=True)

    # Geofence episode ledger (see UpdateLocationView). Internal bookkeeping,
    # never serialized. `outside_since` is set when an on-duty fix first lands
    # outside the Lucena-center radius and cleared when the enforcer returns
    # inside, goes off duty or signs off. `last_alert_at` backs the 15-minute
    # jitter cooldown. Neither field is touched by freshness / live-map logic.
    geofence_outside_since = models.DateTimeField(null=True, blank=True)
    geofence_last_alert_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = 'enforcer_locations'

    def __str__(self):
        return f'{self.enforcer.full_name} - {self.status}'


class EnforcerSchedule(models.Model):
    """
    Monthly schedule for enforcers.
    One record per enforcer per day.
    """

    enforcer      = models.ForeignKey(
        CustomUser, on_delete=models.PROTECT,
        related_name='schedules',
        limit_choices_to={'role': CustomUser.Role.ENFORCER}
    )
    date          = models.DateField()
    shift_start   = models.TimeField()
    shift_end     = models.TimeField()
    break_start   = models.TimeField(null=True, blank=True)
    break_end     = models.TimeField(null=True, blank=True)
    assigned_area = models.CharField(max_length=200)
    notes         = models.TextField(blank=True)
    created_by    = models.ForeignKey(
        CustomUser, on_delete=models.PROTECT, null=True,
        related_name='schedules_created'
    )
    created_at    = models.DateTimeField(auto_now_add=True)
    updated_at    = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'enforcer_schedules'
        unique_together = ['enforcer', 'date']
        ordering        = ['date', 'shift_start']
        indexes         = [
            models.Index(fields=['enforcer', 'date'], name='idx_sched_enforcer_date'),
            models.Index(fields=['date'],             name='idx_sched_date'),
            models.Index(fields=['assigned_area'],    name='idx_sched_area'),
        ]

    def __str__(self):
        return f'{self.enforcer.full_name} — {self.date} ({self.shift_start} - {self.shift_end})'