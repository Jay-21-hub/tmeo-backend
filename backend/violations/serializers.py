from rest_framework import serializers
from .models import Violation, ViolationType, DigitalTicket
from accounts.serializers import UserSerializer


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