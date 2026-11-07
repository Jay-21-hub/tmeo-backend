from django.contrib.auth.models import AbstractBaseUser, BaseUserManager, PermissionsMixin
from django.db import models, transaction
from django.utils import timezone

def current_year():
    return timezone.now().year

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

    # ── ID numbers ────────────────────────────────────────────────────────
    # Format (unchanged): {hired_year}-{ROLE_CODE}-{sequence:04d}
    #   e.g. 2024-ENF-0001, 2025-STF-0003, 2024-ADM-0001
    # The sequence is per (hired_year, role code). The year is ALWAYS the
    # account's original hired_year (never the promotion year), so a person
    # who later changes role keeps the same year prefix.

    def role_code(self, role):
        return CustomUser.ROLE_CODES.get(role, 'USR')

    def reserved_id_numbers(self, prefix=None):
        """Every ID that is, or ever was, issued through a role transition.

        UserRoleHistory remembers both the ID a person LEFT and the ID they
        ENTERED, even after the account row is changed or hard-deleted
        (the ledger survives user deletion). These must never be issued again.
        """
        qs_old = UserRoleHistory.objects.exclude(old_id_number='')
        qs_new = UserRoleHistory.objects.exclude(new_id_number='')
        if prefix:
            qs_old = qs_old.filter(old_id_number__startswith=prefix)
            qs_new = qs_new.filter(new_id_number__startswith=prefix)
        return (
            set(qs_old.values_list('old_id_number', flat=True))
            | set(qs_new.values_list('new_id_number', flat=True))
        )

    def is_id_reserved(self, id_number):
        """True if `id_number` is assigned to an account or retired in the ledger."""
        if not id_number:
            return False
        return (
            CustomUser.objects.filter(id_number=id_number).exists()
            or id_number in self.reserved_id_numbers(id_number)
        )

    def _lock_id_sequence(self, prefix):
        """Serialize ID allocation for one (year, role) prefix on PostgreSQL.

        A transaction-scoped advisory lock: a second allocator for the same
        prefix waits until the first transaction commits, then sees its row.
        It only protects callers that generate AND save inside one
        transaction.atomic() block. No-op on other backends (SQLite already
        serializes writers); the unique constraint on id_number remains the
        final safety net either way.
        """
        conn = transaction.get_connection(using=self._db)
        if conn.vendor == 'postgresql' and conn.in_atomic_block:
            with conn.cursor() as cursor:
                cursor.execute('SELECT pg_advisory_xact_lock(hashtext(%s))', [f'tmeo_id_seq:{prefix}'])

    def generate_id_number(self, role, hired_year):
        """
        Next free ID number for (role, hired_year).

        "Used" means assigned to a current account OR reserved by the
        UserRoleHistory ledger, so a retired ID is never handed to anyone —
        including the same person returning to an earlier role.

        Call this inside the same transaction.atomic() as the save that
        consumes the number (see AdminCreateUserSerializer.create).
        """
        prefix = f"{hired_year}-{self.role_code(role)}-"
        self._lock_id_sequence(prefix)

        used = set(
            CustomUser.objects.filter(id_number__startswith=prefix)
            .values_list('id_number', flat=True)
        )
        used |= self.reserved_id_numbers(prefix)

        last_seq = 0
        for id_number in used:
            tail = id_number[len(prefix):]
            if tail.isdigit():
                last_seq = max(last_seq, int(tail))

        return f"{prefix}{last_seq + 1:04d}"

    def generate_id_number_for_user(self, user, new_role):
        """ID for `user` in `new_role`, using the account's ORIGINAL hired_year (D1)."""
        return self.generate_id_number(new_role, user.hired_year)


class CustomUser(AbstractBaseUser, PermissionsMixin):

    class Role(models.TextChoices):
        ADMIN    = 'admin',    'Administrator'
        STAFF    = 'staff',    'Assessment Staff'
        ENFORCER = 'enforcer', 'Enforcer'

    # Role -> ID-number code. Part of the ID format; do not change.
    ROLE_CODES = {'admin': 'ADM', 'staff': 'STF', 'enforcer': 'ENF'}

    # CSC-based Employment Status
    class EmploymentStatus(models.TextChoices):
        ACTIVE      = 'active',      'Active'
        ON_LEAVE    = 'on_leave',    'On Leave'
        SUSPENDED   = 'suspended',   'Suspended'        
        RESIGNED    = 'resigned',    'Resigned'         
        RETIRED     = 'retired',     'Retired'          
        TERMINATED  = 'terminated',  'Terminated'       
        DROPPED     = 'dropped',     'Dropped from Rolls' 
        DECEASED    = 'deceased',    'Deceased'         
        COTERMINOUS = 'coterminous', 'Coterminous'      

    # Duty Status — for real-time enforcer monitoring
    class DutyStatus(models.TextChoices):
        OFF_DUTY = 'off_duty', 'Off Duty'   # Default
        ON_DUTY  = 'on_duty',  'On Duty'
        ON_BREAK = 'on_break', 'On Break'

    # Core fields
    id_number    = models.CharField(max_length=50, unique=True)
    full_name    = models.CharField(max_length=150)
    # Separate name parts — full_name remains the canonical, always-populated
    # field read across the codebase (audit, violations, notifications, JWT,
    # exports). These are additive: they exist for the Edit User form and are
    # composed back into full_name only at the serializer layer (see
    # build_full_name below and UpdateUserSerializer/AdminCreateUserSerializer),
    # never via a model-wide save() override, so unrelated saves (duty status,
    # FCM token, password reset, etc.) can't accidentally clobber the name.
    last_name    = models.CharField(max_length=100, blank=True)
    first_name   = models.CharField(max_length=100, blank=True)
    middle_name  = models.CharField(max_length=100, blank=True)
    email        = models.EmailField(unique=True)
    phone_number = models.CharField(max_length=20, blank=True)
    role         = models.CharField(
        max_length=20,
        choices=Role.choices,
        default=Role.ENFORCER
    )


    # Employment
    hired_year         = models.IntegerField(default=current_year)
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

    # Government-standard personal info
    class CivilStatus(models.TextChoices):
        SINGLE    = 'single',    'Single'
        MARRIED   = 'married',   'Married'
        WIDOWED   = 'widowed',   'Widowed'
        SEPARATED = 'separated', 'Separated'
        DIVORCED  = 'divorced',  'Divorced'

    address       = models.CharField(max_length=255, blank=True, null=True)
    date_of_birth = models.DateField(blank=True, null=True)
    civil_status  = models.CharField(
        max_length=20,
        choices=CivilStatus.choices,
        blank=True,
        null=True
    )

    # Profile photo
    profile_photo = models.ImageField(upload_to='profiles/', null=True, blank=True)

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


def build_full_name(last_name, first_name, middle_name=''):
    """
    Compose the canonical full_name from separate name parts.
    Format: "Last, First Middle" (Middle only included if present).
    Kept as a free function (not a model method) so it can be reused by
    serializers and the data migration without importing the model there.
    """
    last_name   = (last_name or '').strip()
    first_name  = (first_name or '').strip()
    middle_name = (middle_name or '').strip()

    given = first_name
    if middle_name:
        given = f'{first_name} {middle_name}'.strip()

    if last_name and given:
        return f'{last_name}, {given}'
    return last_name or given


class UserRoleHistory(models.Model):
    """
    Append-only ledger of role / ID-number transitions of ONE account.

    One row = one completed transition of a person (CustomUser.id never
    changes) from `old_role` / `old_id_number` to `new_role` / `new_id_number`
    at `effective_at`. It answers: what role/ID did they leave, what did they
    enter, when, and who did it.

    It is NOT a copy of the user table and it is NOT created for ordinary
    profile edits. The only writer is accounts.services.change_user_role
    (Phase 5), and no row is ever invented for existing users: an account
    with no row simply has never changed role.

    Both IDs are permanently reserved (see UserManager.reserved_id_numbers).
    `user` and `changed_by` are PROTECT (Phase 4, HD-B): an account that
    appears in the ledger has role history and cannot be hard-deleted. The
    reservation itself is stored as plain id-number text, not via the FK.
    """
    user = models.ForeignKey(
        CustomUser, on_delete=models.PROTECT, null=True, blank=True,
        related_name='role_history',
    )
    old_role      = models.CharField(max_length=20, choices=CustomUser.Role.choices)
    new_role      = models.CharField(max_length=20, choices=CustomUser.Role.choices)
    old_id_number = models.CharField(max_length=50)
    new_id_number = models.CharField(max_length=50)

    effective_at = models.DateTimeField(
        default=timezone.now,
        help_text='Server time at which the new role/ID took effect.',
    )
    changed_by = models.ForeignKey(
        CustomUser, on_delete=models.PROTECT, null=True, blank=True,
        related_name='role_changes_made',
        help_text='Administrator who performed the transition.',
    )
    reason     = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = 'tmeo_user_role_history'
        ordering = ['effective_at', 'id']
        indexes  = [
            models.Index(fields=['user', 'effective_at']),
            models.Index(fields=['old_id_number']),
            models.Index(fields=['new_id_number']),
        ]
        constraints = [
            # An ID can be retired by at most one transition, and introduced
            # by at most one transition (IDs are never reissued).
            models.UniqueConstraint(fields=['old_id_number'], name='uniq_role_history_old_id'),
            models.UniqueConstraint(fields=['new_id_number'], name='uniq_role_history_new_id'),
        ]

    def __str__(self):
        return (f'{self.old_id_number} ({self.old_role}) -> '
                f'{self.new_id_number} ({self.new_role}) @ {self.effective_at:%Y-%m-%d}')

    def save(self, *args, **kwargs):
        if not self._state.adding:
            raise RuntimeError('UserRoleHistory is append-only: rows cannot be edited.')
        super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        raise RuntimeError('UserRoleHistory is append-only: rows cannot be deleted.')