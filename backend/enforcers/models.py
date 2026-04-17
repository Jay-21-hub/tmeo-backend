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

    class Meta:
        db_table = 'enforcer_locations'

    def __str__(self):
        return f'{self.enforcer.full_name} - {self.status}'
    
class EnforcerSchedule(models.Model):
    """
    Permanent monthly schedule for enforcers.
    Plottable on calendar — one record per enforcer per day.
    """

    class ShiftType(models.TextChoices):
        MORNING   = 'morning',   'Morning Shift (6AM - 2PM)'
        AFTERNOON = 'afternoon', 'Afternoon Shift (2PM - 10PM)'
        NIGHT     = 'night',     'Night Shift (10PM - 6AM)'
        CUSTOM    = 'custom',    'Custom Shift'

    enforcer      = models.ForeignKey(
        CustomUser, on_delete=models.CASCADE,
        related_name='schedules',
        limit_choices_to={'role': CustomUser.Role.ENFORCER}
    )
    date          = models.DateField()
    shift_type    = models.CharField(
        max_length=20,
        choices=ShiftType.choices,
        default=ShiftType.MORNING
    )
    shift_start   = models.TimeField()
    shift_end     = models.TimeField()
    assigned_area = models.CharField(max_length=200)
    notes         = models.TextField(blank=True)
    created_by    = models.ForeignKey(
        CustomUser, on_delete=models.SET_NULL, null=True,
        related_name='schedules_created'
    )
    created_at    = models.DateTimeField(auto_now_add=True)
    updated_at    = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'enforcer_schedules'
        # One schedule per enforcer per day
        unique_together = ['enforcer', 'date']
        ordering        = ['date', 'shift_start']
        indexes         = [
            models.Index(fields=['enforcer', 'date'], name='idx_sched_enforcer_date'),
            models.Index(fields=['date'],             name='idx_sched_date'),
            models.Index(fields=['assigned_area'],    name='idx_sched_area'),
        ]

    def __str__(self):
        return (
            f'{self.enforcer.full_name} — '
            f'{self.date} ({self.get_shift_type_display()})'
        )