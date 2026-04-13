from rest_framework import serializers
from django.contrib.auth import authenticate
from .models import CustomUser


class RegisterSerializer(serializers.ModelSerializer):
    password         = serializers.CharField(write_only=True, min_length=8)
    confirm_password = serializers.CharField(write_only=True)

    class Meta:
        model  = CustomUser
        fields = [
            'id_number',
            'full_name',
            'email',
            'phone_number',
            'role',
            'badge_number',
            'assigned_area',
            'password',
            'confirm_password',
        ]

    def validate(self, attrs):
        if attrs['password'] != attrs['confirm_password']:
            raise serializers.ValidationError({
                'confirm_password': 'Passwords do not match.'
            })
        return attrs

    def create(self, validated_data):
        validated_data.pop('confirm_password')
        password = validated_data.pop('password')
        user = CustomUser(**validated_data)
        user.set_password(password)
        user.save()
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
        attrs['user'] = user
        return attrs


class UserSerializer(serializers.ModelSerializer):
    role_display = serializers.CharField(
        source='get_role_display',
        read_only=True
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
            'is_active',
            'date_joined',
            'last_login',
        ]
        read_only_fields = ['id', 'date_joined', 'last_login']


class UpdateUserSerializer(serializers.ModelSerializer):
    class Meta:
        model  = CustomUser
        fields = [
            'full_name',
            'phone_number',
            'badge_number',
            'assigned_area',
        ]


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