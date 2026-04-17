from rest_framework import serializers
from django.contrib.auth import authenticate
from django.utils import timezone
from .models import CustomUser


class AdminCreateUserSerializer(serializers.ModelSerializer):
    """
    Admin-only serializer for creating new user accounts.
    - ID number is auto-generated (do not pass manually)
    - Password is auto-generated and sent via email
    - hired_year defaults to current year
    """
    class Meta:
        model  = CustomUser
        fields = [
            'full_name',
            'email',
            'phone_number',
            'role',
            'badge_number',
            'assigned_area',
            'hired_year',
            'employment_status',
        ]

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
        hired_year = validated_data.get('hired_year', timezone.now().year)

        # Auto-generate ID number
        id_number = CustomUser.objects.generate_id_number(role, hired_year)

        # Auto-generate temporary password
        import secrets
        import string
        alphabet         = string.ascii_letters + string.digits
        temp_password    = ''.join(secrets.choice(alphabet) for _ in range(12))

        user = CustomUser(
            id_number  = id_number,
            hired_year = hired_year,
            **validated_data
        )
        user.set_password(temp_password)
        user.save()

        # Store temp_password on instance so view can send via email
        user._temp_password = temp_password
        return user


class LoginSerializer(serializers.Serializer):
    email    = serializers.EmailField()
    password = serializers.CharField(write_only=True)

    def validate(self, attrs):
        user = authenticate(
            username=attrs['email'],
            password=attrs['password']
        )
        if not user:
            raise serializers.ValidationError(
                'Invalid email or password.'
            )
        if not user.is_active:
            raise serializers.ValidationError(
                'Account is deactivated.'
            )
        # Block separated employees from logging in
        if user.is_separated:
            raise serializers.ValidationError(
                'This account has been separated from service.'
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

    class Meta:
        model  = CustomUser
        fields = [
            'id',
            'id_number',
            'full_name',
            'email',
            'phone_number',
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


class UpdateUserSerializer(serializers.ModelSerializer):
    """For admin updating user profile details."""
    class Meta:
        model  = CustomUser
        fields = [
            'full_name',
            'phone_number',
            'badge_number',
            'assigned_area',
            'employment_status',
        ]


class UpdateDutyStatusSerializer(serializers.Serializer):
    """For enforcer updating their own duty status."""
    duty_status = serializers.ChoiceField(
        choices=CustomUser.DutyStatus.choices
    )

    def validate_duty_status(self, value):
        # Cannot manually set to OFF_DUTY mid-shift
        # OFF_DUTY is only set by system at end of schedule
        user = self.context.get('user')
        if (
            value == CustomUser.DutyStatus.OFF_DUTY
            and user
            and user.duty_status == CustomUser.DutyStatus.ON_DUTY
        ):
            raise serializers.ValidationError(
                'Cannot set to Off Duty while on shift. '
                'Contact admin or wait for shift end.'
            )
        return value


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


# Keep RegisterSerializer as alias for backward compat
# but it now points to AdminCreateUserSerializer
RegisterSerializer = AdminCreateUserSerializer