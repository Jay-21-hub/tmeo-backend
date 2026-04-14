from rest_framework import viewsets, filters, status
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.permissions import IsAuthenticated
from accounts.permissions import IsAdminOrStaff, IsEnforcer, IsAdminOrReadOnly
from django_filters.rest_framework import DjangoFilterBackend
from django.utils import timezone

from .models import Violation, ViolationType, DigitalTicket
from .serializers import (
    ViolationSerializer,
    ViolationTypeSerializer,
    DigitalTicketSerializer
)


class ViolationTypeViewSet(viewsets.ModelViewSet):
    queryset           = ViolationType.objects.filter(is_active=True)
    serializer_class   = ViolationTypeSerializer
    permission_classes = [IsAdminOrReadOnly]


class ViolationViewSet(viewsets.ModelViewSet):
    queryset = Violation.objects.select_related(
        'violation_type', 'enforcer', 'assessed_by'
    )
    serializer_class   = ViolationSerializer
    permission_classes = [IsAuthenticated]
    filter_backends    = [filters.SearchFilter, DjangoFilterBackend, filters.OrderingFilter]
    search_fields      = ['violation_id', 'violator_name', 'plate_number', 'license_number']
    filterset_fields   = ['status', 'vehicle_type', 'enforcer', 'violation_type']
    ordering_fields    = ['created_at', 'date_time', 'penalty_amount']
    ordering           = ['-created_at']

    @action(detail=True, methods=['post'])
    def approve(self, request, pk=None):
        violation = self.get_object()
        if violation.status != Violation.Status.PENDING:
            return Response(
                {'error': 'Only pending violations can be approved.'},
                status=status.HTTP_400_BAD_REQUEST
            )
        violation.status      = Violation.Status.APPROVED
        violation.assessed_by = request.user
        violation.save()
        return Response(ViolationSerializer(violation).data)

    @action(detail=True, methods=['post'])
    def generate_ticket(self, request, pk=None):
        violation = self.get_object()
        if hasattr(violation, 'ticket'):
            return Response(
                {'error': 'Ticket already generated.'},
                status=status.HTTP_400_BAD_REQUEST
            )
        ticket_num = f'TKT-{timezone.now().strftime("%Y%m%d")}-{violation.violation_id}'
        ticket = DigitalTicket.objects.create(
            violation     = violation,
            ticket_number = ticket_num,
            generated_by  = request.user,
        )
        return Response(
            DigitalTicketSerializer(ticket).data,
            status=status.HTTP_201_CREATED
        )

    @action(detail=True, methods=['post'])
    def mark_paid(self, request, pk=None):
        violation = self.get_object()
        amount    = request.data.get('amount_paid')
        or_number = request.data.get('or_number', '')
        if not amount:
            return Response(
                {'error': 'amount_paid is required.'},
                status=status.HTTP_400_BAD_REQUEST
            )
        violation.status      = Violation.Status.PAID
        violation.amount_paid = amount
        violation.or_number   = or_number
        violation.date_paid   = timezone.now().date()
        violation.save()
        return Response(ViolationSerializer(violation).data)


class DigitalTicketViewSet(viewsets.ReadOnlyModelViewSet):
    queryset = DigitalTicket.objects.select_related(
        'violation', 'violation__violation_type', 'generated_by'
    )
    serializer_class   = DigitalTicketSerializer
    permission_classes = [IsAuthenticated]
    filter_backends    = [filters.SearchFilter]
    search_fields      = [
        'ticket_number',
        'violation__violator_name',
        'violation__plate_number',
    ]