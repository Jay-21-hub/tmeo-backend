from django.contrib.auth.models import AbstractBaseUser, BaseUserManager, PermissionsMixin
from django.db import models
from django.utils import timezone


class UserManager(BaseUserManager):

    def create_user(self, email, password=None, **extra_fields):
        if not email:
            raise ValueError('Email is required.')
        email = self.normalize_email(email)
        user  = self.model(email=email, **extra_fields)
        user.set_password(password)
        user.save(using=self._db)
        return user

    def create_superuser(self, email, password=None, **extra_fields):
        extra_fields.setdefault('is_staff',     True)
        extra_fields.setdefault('is_superuser', True)
        extra_fields.setdefault('role',         CustomUser.Role.ADMIN)
        return self.create_user(email, password, **extra_fields)

    def generate_id_number(self, role, hired_year):
        """
        Auto-generate ID number in format: YYYY-ROLE-XXXX
        e.g., 2024-ENF-0001, 2025-STF-0003, 2024-ADM-0001
        Resets sequence every year per role.
        """
        role_code = {
            CustomUser.Role.ADMIN:    'ADM',
            CustomUser.Role.STAFF:    'STF',
            CustomUser.Role.ENFORCER: 'ENF',
        }.get(role, 'USR')

        # Count existing users with same year and role
        existing_count = CustomUser.objects.filter(
            hired_year=hired_year,
            role=role
        ).count()

        sequence = existing_count + 1
        return f"{hired_year}-{role_code}-{sequence:04d}"


class CustomUser(AbstractBaseUser, PermissionsMixin):

    class Role(models.TextChoices):
        ADMIN    = 'admin',    'Administrator'
        STAFF    = 'staff',    'Assessment Staff'
        ENFORCER = 'enforcer', 'Enforcer'

    # CSC-based Employment Status
    # Basis: CSC Memorandum Circular No. 40 s. 1998 (as amended),
    # 2025 Omnibus Rules on Appointments and Other Human Resource Actions
    class EmploymentStatus(models.TextChoices):
        ACTIVE      = 'active',      'Active'
        ON_LEAVE    = 'on_leave',    'On Leave'
        SUSPENDED   = 'suspended',   'Suspended'        # Disciplinary action
        RESIGNED    = 'resigned',    'Resigned'         # Voluntary separation
        RETIRED     = 'retired',     'Retired'          # GSIS retirement
        TERMINATED  = 'terminated',  'Terminated'       # Involuntary separation / Fired
        DROPPED     = 'dropped',     'Dropped from Rolls' # CSC Rule XII Sec. 2 - AWOL etc.
        DECEASED    = 'deceased',    'Deceased'         # Death in service
        COTERMINOUS = 'coterminous', 'Coterminous'      # Position ended with appointing authority

    # Duty Status — for real-time enforcer monitoring
    class DutyStatus(models.TextChoices):
        OFF_DUTY = 'off_duty', 'Off Duty'   # Default
        ON_DUTY  = 'on_duty',  'On Duty'
        ON_BREAK = 'on_break', 'On Break'

    # Core fields
    id_number    = models.CharField(max_length=50, unique=True)
    full_name    = models.CharField(max_length=150)
    email        = models.EmailField(unique=True)
    phone_number = models.CharField(max_length=20, blank=True)
    role         = models.CharField(
        max_length=20,
        choices=Role.choices,
        default=Role.ENFORCER
    )

    # Employment
    hired_year         = models.IntegerField(default=timezone.now().year)
    employment_status  = models.CharField(
        max_length=20,
        choices=EmploymentStatus.choices,
        default=EmploymentStatus.ACTIVE
    )

    # Duty monitoring (Enforcer)
    duty_status      = models.CharField(
        max_length=20,
        choices=DutyStatus.choices,
        default=DutyStatus.OFF_DUTY
    )
    duty_status_updated_at = models.DateTimeField(null=True, blank=True)
    break_started_at       = models.DateTimeField(null=True, blank=True)

    # Enforcer-specific
    badge_number  = models.CharField(max_length=50,  blank=True, null=True)
    assigned_area = models.CharField(max_length=200, blank=True, null=True)

    # FCM Push Notifications
    fcm_token = models.CharField(max_length=500, blank=True, null=True)

    # System fields
    is_active   = models.BooleanField(default=True)
    is_staff    = models.BooleanField(default=False)
    date_joined = models.DateTimeField(default=timezone.now)

    objects = UserManager()

    USERNAME_FIELD  = 'email'
    REQUIRED_FIELDS = ['full_name', 'id_number']

    class Meta:
        db_table = 'tmeo_users'
        indexes  = [
            models.Index(fields=['role']),
            models.Index(fields=['employment_status']),
            models.Index(fields=['duty_status']),
            models.Index(fields=['hired_year', 'role']),
        ]

    def __str__(self):
        return f'{self.id_number} — {self.full_name} ({self.get_role_display()})'

    # Role properties
    @property
    def is_admin(self):
        return self.role == self.Role.ADMIN

    @property
    def is_assessment_staff(self):
        return self.role == self.Role.STAFF

    @property
    def is_enforcer(self):
        return self.role == self.Role.ENFORCER

    # Employment status properties
    @property
    def is_currently_active(self):
        return self.employment_status == self.EmploymentStatus.ACTIVE

    @property
    def is_separated(self):
        """True if no longer connected to the agency."""
        separated = [
            self.EmploymentStatus.RESIGNED,
            self.EmploymentStatus.RETIRED,
            self.EmploymentStatus.TERMINATED,
            self.EmploymentStatus.DROPPED,
            self.EmploymentStatus.DECEASED,
            self.EmploymentStatus.COTERMINOUS,
        ]
        return self.employment_status in separated

    # Duty status properties
    @property
    def is_on_duty(self):
        return self.duty_status == self.DutyStatus.ON_DUTY

    @property
    def is_on_break(self):
        return self.duty_status == self.DutyStatus.ON_BREAK