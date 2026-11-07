from rest_framework import serializers
from django.contrib.auth import authenticate
from django.db import IntegrityError, transaction
from django.utils import timezone
from .models import CustomUser, build_full_name

# How many times account creation re-reads the next ID after an id_number collision.
ID_ALLOCATION_ATTEMPTS = 5


class AdminCreateUserSerializer(serializers.ModelSerializer):
    password      = serializers.CharField(write_only=True, required=True, min_length=8)
    address       = serializers.CharField(required=True)
    date_of_birth = serializers.DateField(required=True)
    civil_status  = serializers.ChoiceField(choices=CustomUser.CivilStatus.choices, required=True)
    last_name     = serializers.CharField(required=True, max_length=100)
    first_name    = serializers.CharField(required=True, max_length=100)
    middle_name   = serializers.CharField(required=False, allow_blank=True, max_length=100)

    class Meta:
        model  = CustomUser
        fields = [
            'last_name',
            'first_name',
            'middle_name',
            'email',
            'phone_number',
            'address',
            'date_of_birth',
            'civil_status',
            'role',
            'badge_number',
            'assigned_area',
            'hired_year',
            'employment_status',
            'password',
        ]

    def validate_last_name(self, value):
        if not value.strip():
            raise serializers.ValidationError('Last name is required.')
        return value.strip()

    def validate_first_name(self, value):
        if not value.strip():
            raise serializers.ValidationError('First name is required.')
        return value.strip()

    def validate_email(self, value):
        if CustomUser.objects.filter(email=value).exists():
            raise serializers.ValidationError(
                'A user with this email already exists.'
            )
        return value

    def validate_hired_year(self, value):
        current_year = timezone.now().year
        if value < 2000 or value > current_year:
            raise serializers.ValidationError(
                f'Hired year must be between 2000 and {current_year}.'
            )
        return value

    def create(self, validated_data):
        role       = validated_data.get('role', CustomUser.Role.ENFORCER)
        hired_year = validated_data.pop('hired_year', timezone.now().year)
        password   = validated_data.pop('password')

        last_name   = validated_data.get('last_name', '')
        first_name  = validated_data.get('first_name', '')
        middle_name = validated_data.get('middle_name', '')
        full_name   = build_full_name(last_name, first_name, middle_name)

        # Auto-generate the ID number and save in ONE transaction so the
        # PostgreSQL advisory lock taken by generate_id_number() is held
        # until the new row is committed (two concurrent creations can no
        # longer read the same "next" sequence). If the unique constraint
        # still trips on id_number (e.g. a non-PostgreSQL backend), retry
        # with a fresh number; any other IntegrityError is re-raised.
        for attempt in range(ID_ALLOCATION_ATTEMPTS):
            id_number = None
            try:
                with transaction.atomic():
                    id_number = CustomUser.objects.generate_id_number(role, hired_year)
                    user = CustomUser(
                        id_number  = id_number,
                        hired_year = hired_year,
                        is_active  = True,
                        full_name  = full_name,
                        **validated_data
                    )
                    user.set_password(password)
                    user.save()
                break
            except IntegrityError:
                id_taken = id_number and CustomUser.objects.filter(id_number=id_number).exists()
                if not id_taken or attempt == ID_ALLOCATION_ATTEMPTS - 1:
                    raise

        user._plain_password = password
        return user


class LoginSerializer(serializers.Serializer):
    id_number = serializers.CharField()
    password  = serializers.CharField(write_only=True)

    def validate(self, attrs):
        try:
            user_obj = CustomUser.objects.get(id_number=attrs['id_number'])
        except CustomUser.DoesNotExist:
            raise serializers.ValidationError(
                'Invalid ID number or password.'
            )

        user = authenticate(
            username=user_obj.email,
            password=attrs['password']
        )
        if not user:
            raise serializers.ValidationError(
                'Invalid ID number or password.'
            )
        if not user.is_active or user.is_separated:
            raise serializers.ValidationError(
                'Account access restricted.'
            )
        attrs['user'] = user
        return attrs


class UserSerializer(serializers.ModelSerializer):
    role_display             = serializers.CharField(
        source='get_role_display', read_only=True
    )
    employment_status_display = serializers.CharField(
        source='get_employment_status_display', read_only=True
    )
    duty_status_display      = serializers.CharField(
        source='get_duty_status_display', read_only=True
    )
    civil_status_display     = serializers.CharField(
        source='get_civil_status_display', read_only=True
    )
    profile_photo_url        = serializers.SerializerMethodField()

    class Meta:
        model  = CustomUser
        fields = [
            'id',
            'id_number',
            'full_name',
            'last_name',
            'first_name',
            'middle_name',
            'email',
            'phone_number',
            'address',
            'date_of_birth',
            'civil_status',
            'civil_status_display',
            'role',
            'role_display',
            'badge_number',
            'assigned_area',
            'hired_year',
            'employment_status',
            'employment_status_display',
            'duty_status',
            'duty_status_display',
            'duty_status_updated_at',
            'break_started_at',
            'profile_photo_url',
            'is_active',
            'date_joined',
            'last_login',
        ]
        read_only_fields = [
            'id',
            'id_number',
            'hired_year',
            'date_joined',
            'last_login',
            'duty_status_updated_at',
            'break_started_at',
        ]

    def get_profile_photo_url(self, obj):
        if obj.profile_photo:
            try:
                return obj.profile_photo.url
            except ValueError:
                return None
        return None


class ClearableImageField(serializers.ImageField):
    """
    An ImageField that also accepts an empty string as "remove the photo".

    Multipart/form-data (what the browser sends for file uploads) has no
    concept of a JSON `null` — every value is a string. DRF's base
    ImageField treats an empty string as invalid input ("not a file"), so
    without this override there would be no way to clear a photo from a
    multipart request. An empty string is treated the same as `None`.
    """
    def to_internal_value(self, data):
        if data == '' or data is None:
            return None
        return super().to_internal_value(data)


class SelfUpdateUserSerializer(serializers.ModelSerializer):
    """
    For a user editing THEIR OWN profile via MeView (/api/accounts/me/).

    Deliberately excludes:
      - administrative/employment fields (employment_status,
        badge_number, assigned_area) — admin-only, must go through
        UserDetailView, gated by request.user.is_admin.
      - identity/official-record fields (full_name, date_of_birth) —
        tied to official records (full_name feeds id_number
        generation) and shouldn't change without an admin-reviewed
        approval trail, so also admin-only via UserDetailView.

    The frontend's ProfileEditForm already hides the administrative
    fields, but the backend must not trust that; a request crafted
    directly against the API must not be able to self-edit them
    either. Only low-risk, frequently-changing contact/personal info
    (phone_number, address, civil_status, profile_photo) stays
    self-editable here.
    """

    profile_photo = ClearableImageField(
        required=False, allow_null=True
    )

    ALLOWED_CONTENT_TYPES = {'image/jpeg', 'image/png', 'image/webp'}
    MAX_PHOTO_SIZE_BYTES  = 5 * 1024 * 1024  # 5MB

    class Meta:
        model  = CustomUser
        fields = [
            'phone_number',
            'address',
            'civil_status',
            'profile_photo',
        ]

    def validate_profile_photo(self, value):
        if value is None:
            return value

        content_type = getattr(value, 'content_type', None)
        if content_type not in self.ALLOWED_CONTENT_TYPES:
            raise serializers.ValidationError(
                'Only JPEG, PNG, or WEBP images are allowed.'
            )
        if value.size > self.MAX_PHOTO_SIZE_BYTES:
            raise serializers.ValidationError(
                'Image must be smaller than 5MB.'
            )
        return value


class UpdateUserSerializer(serializers.ModelSerializer):
    """For admin updating another user's profile details (UserDetailView).

    NOTE: also historically reused by MeView for self-updates, which was
    the bug — see SelfUpdateUserSerializer above. Do not repoint MeView
    back to this serializer; it intentionally includes administrative
    fields (badge_number, assigned_area, employment_status) that only an
    admin should be able to set, and UserDetailView.patch enforces that
    via request.user.is_admin.
    """

    # Explicit field so we can validate type/size server-side and accept
    # an empty string / null as an explicit "remove the photo" signal.
    profile_photo = ClearableImageField(
        required=False, allow_null=True
    )

    ALLOWED_CONTENT_TYPES = {'image/jpeg', 'image/png', 'image/webp'}
    MAX_PHOTO_SIZE_BYTES  = 5 * 1024 * 1024  # 5MB

    last_name   = serializers.CharField(required=False, allow_blank=True, max_length=100)
    first_name  = serializers.CharField(required=False, allow_blank=True, max_length=100)
    middle_name = serializers.CharField(required=False, allow_blank=True, max_length=100)

    class Meta:
        model  = CustomUser
        fields = [
            'full_name',
            'last_name',
            'first_name',
            'middle_name',
            'phone_number',
            'address',
            'date_of_birth',
            'civil_status',
            'badge_number',
            'assigned_area',
            'employment_status',
            'profile_photo',
        ]
        # full_name is derived, not directly settable via this endpoint —
        # it's recomputed in update() from last/first/middle name instead,
        # so a client can't send a full_name that disagrees with the parts.
        read_only_fields = ['full_name']

    def validate_profile_photo(self, value):
        # None means "remove the photo" — allowed through untouched.
        if value is None:
            return value

        content_type = getattr(value, 'content_type', None)
        if content_type not in self.ALLOWED_CONTENT_TYPES:
            raise serializers.ValidationError(
                'Only JPEG, PNG, or WEBP images are allowed.'
            )
        if value.size > self.MAX_PHOTO_SIZE_BYTES:
            raise serializers.ValidationError(
                'Image must be smaller than 5MB.'
            )
        return value

    def update(self, instance, validated_data):
        # Recompute full_name only when the patch actually carries name-part
        # data AND the resulting name would be complete. This guards two
        # ways at once:
        #  - a legacy user (blank first_name/last_name from before this
        #    feature) being edited for an unrelated field (e.g. just
        #    employment_status) never gets full_name blanked out.
        #  - a partial name patch mid-edit can't silently produce a
        #    half-composed full_name.
        name_parts_touched = any(
            f in validated_data for f in ('last_name', 'first_name', 'middle_name')
        )
        instance = super().update(instance, validated_data)

        if name_parts_touched:
            resulting_last  = instance.last_name
            resulting_first = instance.first_name
            if resulting_last.strip() and resulting_first.strip():
                instance.full_name = build_full_name(
                    resulting_last, resulting_first, instance.middle_name
                )
                instance.save(update_fields=['full_name'])

        return instance


class UpdateDutyStatusSerializer(serializers.Serializer):
    """
    Legacy request shape for POST /api/auth/duty-status/.

    The value is only checked for being a known choice. It is NOT authoritative:
    the view recomputes duty from today's schedule + local time and ignores a
    conflicting request (so a stale on_duty -> off_duty transition is no longer
    rejected, and an unscheduled enforcer cannot post themselves on duty).
    """
    duty_status = serializers.ChoiceField(
        choices=CustomUser.DutyStatus.choices,
        required=False,
    )


class ChangePasswordSerializer(serializers.Serializer):
    old_password     = serializers.CharField(write_only=True)
    new_password     = serializers.CharField(write_only=True, min_length=8)
    confirm_password = serializers.CharField(write_only=True)

    def validate(self, attrs):
        if attrs['new_password'] != attrs['confirm_password']:
            raise serializers.ValidationError({
                'confirm_password': 'Passwords do not match.'
            })
        return attrs


class ForgotPasswordSerializer(serializers.Serializer):
    email = serializers.EmailField()

    def validate_email(self, value):
        if not CustomUser.objects.filter(email=value).exists():
            # Security: don't reveal if email exists or not
            # Just return value silently
            pass
        return value


class ResetPasswordSerializer(serializers.Serializer):
    token            = serializers.CharField()
    new_password     = serializers.CharField(write_only=True, min_length=8)
    confirm_password = serializers.CharField(write_only=True)

    def validate(self, attrs):
        if attrs['new_password'] != attrs['confirm_password']:
            raise serializers.ValidationError({
                'confirm_password': 'Passwords do not match.'
            })
        return attrs

RegisterSerializer = AdminCreateUserSerializer