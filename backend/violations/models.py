from django.db import models
from accounts.models import CustomUser


class ViolationType(models.Model):
    class Category(models.TextChoices):
        SAFETY  = 'safety',  'Safety Violation'
        TRAFFIC = 'traffic', 'Traffic Violation'
        OTHER   = 'other',   'Other'

    code           = models.CharField(max_length=20, unique=True)
    name           = models.CharField(max_length=100)
    description    = models.TextField(blank=True)
    category       = models.CharField(max_length=20, choices=Category.choices)
    penalty_amount = models.DecimalField(max_digits=10, decimal_places=2)
    is_active      = models.BooleanField(default=True)
    created_at     = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = 'violation_types'
        ordering = ['code']
        indexes  = [
            models.Index(fields=['category'], name='idx_vtype_category'),
            models.Index(fields=['is_active'], name='idx_vtype_is_active'),
        ]

    def __str__(self):
        return f'{self.code} - {self.name}'


class Violation(models.Model):
    class Status(models.TextChoices):
        PENDING  = 'pending',  'Pending'
        APPROVED = 'approved', 'Approved'
        PAID     = 'paid',     'Paid'
        VOIDED   = 'voided',   'Voided'

    class VehicleType(models.TextChoices):
        MOTORCYCLE = 'motorcycle', 'Motorcycle'
        SEDAN      = 'sedan',      'Sedan'
        SUV        = 'suv',        'SUV'
        VAN        = 'van',        'Van'
        TRICYCLE   = 'tricycle',   'Tricycle'
        TRUCK      = 'truck',      'Truck'
        OTHER      = 'other',      'Other'

    violation_id   = models.CharField(max_length=20, unique=True, editable=False)
    violator_name  = models.CharField(max_length=150)
    license_number = models.CharField(max_length=50)
    plate_number   = models.CharField(max_length=20)
    vehicle_type   = models.CharField(max_length=20, choices=VehicleType.choices)
    address        = models.TextField(blank=True)
    violation_type = models.ForeignKey(
        ViolationType, on_delete=models.PROTECT, related_name='violations'
    )
    date_time      = models.DateTimeField()
    location       = models.CharField(max_length=255)
    latitude       = models.FloatField(null=True, blank=True)
    longitude      = models.FloatField(null=True, blank=True)
    status         = models.CharField(
        max_length=20, choices=Status.choices, default=Status.PENDING
    )
    enforcer = models.ForeignKey(
        CustomUser, on_delete=models.SET_NULL, null=True,
        related_name='violations_issued'
    )
    # Snapshot of enforcer's role at time of recording
    # So records remain traceable even after role changes
    enforcer_role_snapshot = models.CharField(
        max_length=20,
        choices=CustomUser.Role.choices,
        blank=True,
        null=True,
        editable=False,
    )
    assessed_by = models.ForeignKey(
        CustomUser, on_delete=models.SET_NULL, null=True, blank=True,
        related_name='violations_assessed'
    )

    # Immutable after creation — penalty is locked at time of recording
    # Changing ViolationType penalty only affects NEW violations
    penalty_amount = models.DecimalField(
        max_digits=10, decimal_places=2, editable=False
    )
    amount_paid    = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    or_number      = models.CharField(max_length=50, blank=True)
    date_paid      = models.DateField(null=True, blank=True)
    evidence_image = models.TextField(blank=True, null=True)  # Base64 image
    created_at     = models.DateTimeField(auto_now_add=True)
    updated_at     = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'violations'
        ordering = ['-created_at']
        indexes  = [
            models.Index(fields=['status'],         name='idx_violation_status'),
            models.Index(fields=['plate_number'],   name='idx_violation_plate'),
            models.Index(fields=['enforcer'],       name='idx_violation_enforcer'),
            models.Index(fields=['date_time'],      name='idx_violation_datetime'),
            models.Index(fields=['created_at'],     name='idx_violation_created'),
            models.Index(fields=['violation_type'], name='idx_violation_type'),
        ]

    def save(self, *args, **kwargs):
        # Auto-generate violation ID
        if not self.violation_id:
            last    = Violation.objects.order_by('-id').first()
            next_id = (last.id + 1) if last else 1
            self.violation_id = f'VL-{next_id:06d}'

        # Snapshot enforcer's role at time of first save
        if not self.pk and self.enforcer:
            self.enforcer_role_snapshot = self.enforcer.role

        # Penalty immutability — block changes after creation
        if self.pk:
            original = Violation.objects.filter(pk=self.pk).values(
                'penalty_amount'
            ).first()
            if original:
                self.penalty_amount = original['penalty_amount']

        super().save(*args, **kwargs)

    def __str__(self):
        return f'{self.violation_id} - {self.violator_name}'


class DigitalTicket(models.Model):
    violation     = models.OneToOneField(
        Violation, on_delete=models.CASCADE, related_name='ticket'
    )
    ticket_number = models.CharField(max_length=50, unique=True)
    generated_by  = models.ForeignKey(
        CustomUser, on_delete=models.SET_NULL, null=True
    )
    generated_at  = models.DateTimeField(auto_now_add=True)
    is_printed    = models.BooleanField(default=False)
    printed_at    = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = 'digital_tickets'
        indexes  = [
            models.Index(fields=['ticket_number'], name='idx_ticket_number'),
        ]

    def __str__(self):
        return self.ticket_number