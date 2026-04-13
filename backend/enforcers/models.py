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