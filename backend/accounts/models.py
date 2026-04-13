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


class CustomUser(AbstractBaseUser, PermissionsMixin):

    class Role(models.TextChoices):
        ADMIN    = 'admin',    'Administrator'
        STAFF    = 'staff',    'Assessment Staff'
        ENFORCER = 'enforcer', 'Enforcer'

    id_number    = models.CharField(max_length=50, unique=True)
    full_name    = models.CharField(max_length=150)
    email        = models.EmailField(unique=True)
    phone_number = models.CharField(max_length=20, blank=True)
    role         = models.CharField(
        max_length=20,
        choices=Role.choices,
        default=Role.ENFORCER
    )
    badge_number  = models.CharField(max_length=50,  blank=True, null=True)
    assigned_area = models.CharField(max_length=200, blank=True, null=True)
    is_active     = models.BooleanField(default=True)
    is_staff      = models.BooleanField(default=False)
    date_joined   = models.DateTimeField(default=timezone.now)

    objects = UserManager()

    USERNAME_FIELD  = 'email'
    REQUIRED_FIELDS = ['full_name', 'id_number']

    class Meta:
        db_table = 'tmeo_users'

    def __str__(self):
        return f'{self.full_name} ({self.get_role_display()})'

    @property
    def is_admin(self):
        return self.role == self.Role.ADMIN

    @property
    def is_assessment_staff(self):
        return self.role == self.Role.STAFF

    @property
    def is_enforcer(self):
        return self.role == self.Role.ENFORCER