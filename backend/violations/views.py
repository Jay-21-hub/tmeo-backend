from rest_framework import viewsets, filters, status
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.permissions import IsAuthenticated
from accounts.permissions import IsAdminOrStaff, IsEnforcer, IsAdminOrReadOnly
from django_filters.rest_framework import DjangoFilterBackend
from django.utils import timezone
from audit.utils import log_action

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

    def perform_create(self, serializer):
        vtype = serializer.save()
        log_action(
            user        = self.request.user,
            action      = 'CREATE',
            module      = 'Violations',
            description = f'Created violation type: {vtype.name} ({vtype.code})',
            request     = self.request,
        )

    def perform_update(self, serializer):
        vtype = serializer.save()
        log_action(
            user        = self.request.user,
            action      = 'UPDATE',
            module      = 'Violations',
            description = f'Updated violation type: {vtype.name} ({vtype.code})',
            request     = self.request,
        )

    def perform_destroy(self, instance):
        log_action(
            user        = self.request.user,
            action      = 'DELETE',
            module      = 'Violations',
            description = f'Deleted violation type: {instance.name} ({instance.code})',
            request     = self.request,
        )
        instance.delete()


class ViolationViewSet(viewsets.ModelViewSet):
    serializer_class   = ViolationSerializer
    permission_classes = [IsAuthenticated]
    filter_backends    = [filters.SearchFilter, DjangoFilterBackend, filters.OrderingFilter]
    search_fields      = ['violation_id', 'violator_name', 'plate_number', 'license_number']
    filterset_fields   = ['status', 'vehicle_type', 'enforcer', 'violation_type']
    ordering_fields    = ['created_at', 'date_time', 'penalty_amount']
    ordering           = ['-created_at']

    def get_queryset(self):
        user = self.request.user
        qs   = Violation.objects.select_related(
            'violation_type', 'enforcer', 'assessed_by'
        )
        # Enforcer sees only their own violations
        if user.is_enforcer:
            return qs.filter(enforcer=user)
        # Admin and Staff see all
        return qs

    def perform_create(self, serializer):
        violation = serializer.save()
        log_action(
            user        = self.request.user,
            action      = 'CREATE',
            module      = 'Violations',
            description = f'Recorded violation {violation.violation_id} for {violation.violator_name} ({violation.plate_number})',
            request     = self.request,
        )

    def perform_update(self, serializer):
        violation = serializer.save()
        log_action(
            user        = self.request.user,
            action      = 'UPDATE',
            module      = 'Violations',
            description = f'Updated violation {violation.violation_id} — status: {violation.status}',
            request     = self.request,
        )

    def perform_destroy(self, instance):
        log_action(
            user        = self.request.user,
            action      = 'DELETE',
            module      = 'Violations',
            description = f'Deleted violation {instance.violation_id} for {instance.violator_name}',
            request     = self.request,
        )
        instance.delete()

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
        log_action(
            user        = request.user,
            action      = 'UPDATE',
            module      = 'Violations',
            description = f'Approved violation {violation.violation_id} for {violation.violator_name}',
            request     = request,
        )
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
        log_action(
            user        = request.user,
            action      = 'CREATE',
            module      = 'Violations',
            description = f'Generated ticket {ticket_num} for violation {violation.violation_id}',
            request     = request,
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
        log_action(
            user        = request.user,
            action      = 'UPDATE',
            module      = 'Violations',
            description = f'Marked violation {violation.violation_id} as PAID — OR#: {or_number}, Amount: {amount}',
            request     = request,
        )
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

from rest_framework.views import APIView

class OCRScanView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        from .ocr import extract_text_from_base64, parse_license_info

        image = request.data.get('image')
        if not image:
            return Response(
                {'error': 'image is required.'},
                status=status.HTTP_400_BAD_REQUEST
            )

        text_list = extract_text_from_base64(image)
        if not text_list:
            return Response(
                {'error': 'No text detected. Please retake the photo.'},
                status=status.HTTP_400_BAD_REQUEST
            )

        parsed = parse_license_info(text_list)
        return Response({
            'raw_text': text_list,
            'parsed':   parsed,
        })
    
class VoidViolationView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, pk):
        if not (request.user.is_admin or request.user.is_staff_member):
            return Response(
                {'error': 'Permission denied.'},
                status=status.HTTP_403_FORBIDDEN
            )
        try:
            violation = Violation.objects.get(pk=pk)
        except Violation.DoesNotExist:
            return Response(
                {'error': 'Violation not found.'},
                status=status.HTTP_404_NOT_FOUND
            )
        if violation.status == Violation.Status.VOIDED:
            return Response(
                {'error': 'Violation is already voided.'},
                status=status.HTTP_400_BAD_REQUEST
            )
        if violation.status == Violation.Status.PAID:
            return Response(
                {'error': 'Cannot void a paid violation.'},
                status=status.HTTP_400_BAD_REQUEST
            )
        reason = request.data.get('reason', '').strip()
        if not reason:
            return Response(
                {'error': 'reason is required to void a violation.'},
                status=status.HTTP_400_BAD_REQUEST
            )
        violation.status = Violation.Status.VOIDED
        violation.save()
        log_action(
            user        = request.user,
            action      = 'UPDATE',
            module      = 'Violations',
            description = (
                f'Voided violation {violation.violation_id} '
                f'for {violation.violator_name} — Reason: {reason}'
            ),
            request     = request,
        )
        return Response(ViolationSerializer(violation).data)


class ViolationDashboardStatsView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        if not (request.user.is_admin or request.user.is_staff_member):
            return Response(
                {'error': 'Permission denied.'},
                status=status.HTTP_403_FORBIDDEN
            )
        from django.db.models import Sum, Count
        from datetime import date

        today      = date.today()
        this_month = Violation.objects.filter(
            date_time__year  = today.year,
            date_time__month = today.month,
        )
        total    = Violation.objects.count()
        pending  = Violation.objects.filter(status=Violation.Status.PENDING).count()
        approved = Violation.objects.filter(status=Violation.Status.APPROVED).count()
        paid     = Violation.objects.filter(status=Violation.Status.PAID).count()
        voided   = Violation.objects.filter(status=Violation.Status.VOIDED).count()

        total_collected = (
            Violation.objects.filter(status=Violation.Status.PAID)
            .aggregate(total=Sum('amount_paid'))['total'] or 0
        )
        monthly_count = this_month.count()
        monthly_collected = (
            this_month.filter(status=Violation.Status.PAID)
            .aggregate(total=Sum('amount_paid'))['total'] or 0
        )
        top_violations = (
            this_month
            .values('violation_type__name', 'violation_type__code')
            .annotate(count=Count('id'))
            .order_by('-count')[:5]
        )
        return Response({
            'total':           total,
            'pending':         pending,
            'approved':        approved,
            'paid':            paid,
            'voided':          voided,
            'total_collected': float(total_collected),
            'monthly': {
                'count':     monthly_count,
                'collected': float(monthly_collected),
            },
            'top_violations_this_month': list(top_violations),
        })