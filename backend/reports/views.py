from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework.permissions import IsAuthenticated
from django.utils import timezone
from django.db.models import Count, Sum, Q
from datetime import timedelta

from violations.models import Violation, ViolationType
from accounts.models import CustomUser


class DashboardStatsView(APIView):
    """
    Main dashboard stats —
    Total violations, today, pending, approved, active enforcers
    """
    permission_classes = [IsAuthenticated]

    def get(self, request):
        today = timezone.now().date()

        total_violations    = Violation.objects.count()
        violations_today    = Violation.objects.filter(
            created_at__date=today
        ).count()
        pending_assessments = Violation.objects.filter(
            status='pending'
        ).count()
        approved_violations = Violation.objects.filter(
            status='approved'
        ).count()
        active_enforcers    = CustomUser.objects.filter(
            role='enforcer', is_active=True
        ).count()

        return Response({
            'total_violations':    total_violations,
            'violations_today':    violations_today,
            'pending_assessments': pending_assessments,
            'approved_violations': approved_violations,
            'active_enforcers':    active_enforcers,
        })


class ViolationByTypeView(APIView):
    """
    Violation by Type — pie/donut chart data
    Distribution of violation categories
    """
    permission_classes = [IsAuthenticated]

    def get(self, request):
        data = Violation.objects.values(
            'violation_type__name',
            'violation_type__category',
        ).annotate(
            count=Count('id')
        ).order_by('-count')

        return Response([{
            'name':     item['violation_type__name'],
            'category': item['violation_type__category'],
            'count':    item['count'],
        } for item in data])


class ViolationTrendsView(APIView):
    """
    Violation Trends — bar/line chart data
    Monthly violation records over the past 7 months
    """
    permission_classes = [IsAuthenticated]

    def get(self, request):
        today    = timezone.now()
        months   = []

        for i in range(6, -1, -1):
            # Go back i months from today
            month_date  = today - timedelta(days=i * 30)
            month_start = month_date.replace(day=1).date()

            # Get last day of month
            if month_date.month == 12:
                month_end = month_date.replace(
                    day=31
                ).date()
            else:
                month_end = month_date.replace(
                    month=month_date.month + 1, day=1
                ).date() - timedelta(days=1)

            count = Violation.objects.filter(
                created_at__date__gte=month_start,
                created_at__date__lte=month_end,
            ).count()

            months.append({
                'month': month_date.strftime('%b %Y'),
                'count': count,
            })

        return Response(months)


class ViolationHotspotsView(APIView):
    """
    Violation Hotspots —
    Top 3 locations with most violations
    """
    permission_classes = [IsAuthenticated]

    def get(self, request):
        data = Violation.objects.values(
            'location'
        ).annotate(
            count=Count('id')
        ).order_by('-count')[:3]

        return Response([{
            'location': item['location'],
            'count':    item['count'],
        } for item in data])


class TopEnforcersView(APIView):
    """
    Top Enforcers this month —
    Most active enforcement officers
    """
    permission_classes = [IsAuthenticated]

    def get(self, request):
        today       = timezone.now()
        month_start = today.replace(day=1).date()

        data = Violation.objects.filter(
            created_at__date__gte=month_start
        ).values(
            'enforcer__full_name',
            'enforcer__badge_number',
            'enforcer__id',
        ).annotate(
            ticket_count=Count('id')
        ).order_by('-ticket_count')[:3]

        return Response([{
            'id':           item['enforcer__id'],
            'name':         item['enforcer__full_name'],
            'badge_number': item['enforcer__badge_number'],
            'ticket_count': item['ticket_count'],
        } for item in data])


class CollectionSummaryView(APIView):
    """
    Collection Summary —
    Revenue from penalties this month
    """
    permission_classes = [IsAuthenticated]

    def get(self, request):
        today       = timezone.now()
        month_start = today.replace(day=1).date()

        monthly = Violation.objects.filter(
            created_at__date__gte=month_start
        )

        total_collected = monthly.filter(
            status='paid'
        ).aggregate(
            total=Sum('amount_paid')
        )['total'] or 0

        pending_payments = monthly.filter(
            status__in=['pending', 'approved']
        ).aggregate(
            total=Sum('penalty_amount')
        )['total'] or 0

        total_violations = monthly.count()
        paid_violations  = monthly.filter(status='paid').count()

        collection_rate = (
            round((paid_violations / total_violations) * 100, 1)
            if total_violations > 0 else 0
        )

        return Response({
            'total_collected':  total_collected,
            'pending_payments': pending_payments,
            'collection_rate':  f'{collection_rate}%',
        })


class GenerateReportView(APIView):
    """
    Generate reports —
    Daily, Monthly, By Type, Enforcer Activity
    """
    permission_classes = [IsAuthenticated]

    def get(self, request):
        report_type = request.query_params.get('type')
        date_from   = request.query_params.get('date_from')
        date_to     = request.query_params.get('date_to')

        violations = Violation.objects.all()

        # Filter by date range if provided
        if date_from:
            violations = violations.filter(
                created_at__date__gte=date_from
            )
        if date_to:
            violations = violations.filter(
                created_at__date__lte=date_to
            )

        if report_type == 'daily':
            data = violations.values(
                'created_at__date'
            ).annotate(
                count=Count('id'),
                total_penalties=Sum('penalty_amount'),
            ).order_by('created_at__date')

            return Response([{
                'date':             str(item['created_at__date']),
                'count':            item['count'],
                'total_penalties':  item['total_penalties'] or 0,
            } for item in data])

        elif report_type == 'monthly':
            data = violations.values(
                'created_at__year',
                'created_at__month',
            ).annotate(
                count=Count('id'),
                total_penalties=Sum('penalty_amount'),
            ).order_by('created_at__year', 'created_at__month')

            return Response([{
                'year':            item['created_at__year'],
                'month':           item['created_at__month'],
                'count':           item['count'],
                'total_penalties': item['total_penalties'] or 0,
            } for item in data])

        elif report_type == 'by_type':
            data = violations.values(
                'violation_type__name',
                'violation_type__category',
            ).annotate(
                count=Count('id'),
                total_penalties=Sum('penalty_amount'),
            ).order_by('-count')

            return Response([{
                'violation_type':  item['violation_type__name'],
                'category':        item['violation_type__category'],
                'count':           item['count'],
                'total_penalties': item['total_penalties'] or 0,
            } for item in data])

        elif report_type == 'enforcer_activity':
            data = violations.values(
                'enforcer__full_name',
                'enforcer__badge_number',
            ).annotate(
                total_issued=Count('id'),
                total_penalties=Sum('penalty_amount'),
            ).order_by('-total_issued')

            return Response([{
                'enforcer':        item['enforcer__full_name'],
                'badge_number':    item['enforcer__badge_number'],
                'total_issued':    item['total_issued'],
                'total_penalties': item['total_penalties'] or 0,
            } for item in data])

        return Response(
            {'error': 'Invalid report type. Choose: daily, monthly, by_type, enforcer_activity'},
            status=400
        )