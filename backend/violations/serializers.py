import base64
import uuid
from rest_framework import serializers
from .models import Violation, ViolationType, DigitalTicket
from accounts.serializers import UserSerializer


class Base64ImageField(serializers.Field):
    """
    Accepts Base64-encoded image string.
    Validates format and size (max 5MB).
    """
    MAX_SIZE_BYTES = 5 * 1024 * 1024  # 5MB

    def to_representation(self, value):
        return value  # Return as-is (already Base64 string)

    def to_internal_value(self, data):
        if not isinstance(data, str):
            raise serializers.ValidationError("Image must be a Base64 string.")

        # Allow empty/null
        if not data:
            return data

        # Check prefix format: data:image/jpeg;base64,....
        if not data.startswith('data:image/'):
            raise serializers.ValidationError(
                "Invalid format. Must start with 'data:image/jpeg;base64,' or similar."
            )

        try:
            header, encoded = data.split(',', 1)
        except ValueError:
            raise serializers.ValidationError("Invalid Base64 image format.")

        # Validate it's actually Base64
        try:
            decoded = base64.b64decode(encoded)
        except Exception:
            raise serializers.ValidationError("Invalid Base64 encoding.")

        # Check file size
        if len(decoded) > self.MAX_SIZE_BYTES:
            raise serializers.ValidationError(
                f"Image too large. Maximum size is 5MB."
            )

        # Check image type from header
        allowed_types = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp']
        image_type = header.split(';')[0].replace('data:', '')
        if image_type not in allowed_types:
            raise serializers.ValidationError(
                f"Unsupported image type: {image_type}. Allowed: jpeg, png, webp."
            )

        return data  # Store the full Base64 string


class ViolationTypeSerializer(serializers.ModelSerializer):
    class Meta:
        model  = ViolationType
        fields = '__all__'


class ViolationSerializer(serializers.ModelSerializer):
    violation_type_detail = ViolationTypeSerializer(
        source='violation_type', read_only=True
    )
    enforcer_detail    = UserSerializer(source='enforcer',    read_only=True)
    assessed_by_detail = UserSerializer(source='assessed_by', read_only=True)
    status_display     = serializers.CharField(
        source='get_status_display', read_only=True
    )
    vehicle_type_display = serializers.CharField(
        source='get_vehicle_type_display', read_only=True
    )
    evidence_image = Base64ImageField(required=False, allow_null=True)

    class Meta:
        model  = Violation
        fields = '__all__'
        read_only_fields = ['violation_id', 'created_at', 'updated_at']


class DigitalTicketSerializer(serializers.ModelSerializer):
    violation_detail    = ViolationSerializer(source='violation',    read_only=True)
    generated_by_detail = UserSerializer(source='generated_by', read_only=True)

    class Meta:
        model  = DigitalTicket
        fields = '__all__'
        read_only_fields = ['ticket_number', 'generated_at']