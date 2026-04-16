from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework.permissions import IsAuthenticated
from accounts.permissions import IsAdmin, IsAdminOrStaff
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
    permission_classes = [IsAdmin]

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
    
import openpyxl
from openpyxl.utils import get_column_letter
from reportlab.lib.pagesizes import letter
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib import colors
from django.http import HttpResponse
from violations.models import Violation


class ExportViolationsPDFView(APIView):
    permission_classes = [IsAdminOrStaff]

    def get(self, request):
        response = HttpResponse(content_type='application/pdf')
        response['Content-Disposition'] = 'attachment; filename="violations.pdf"'

        doc = SimpleDocTemplate(response, pagesize=letter)
        styles = getSampleStyleSheet()
        elements = []

        elements.append(Paragraph("Violations Report", styles['Title']))

        violations = Violation.objects.select_related('violation_type', 'enforcer').all()

        data = [['ID', 'Violator', 'Violation Type', 'Status', 'Penalty', 'Date']]
        for v in violations:
            data.append([
                v.violation_id,
                v.violator_name,
                v.violation_type.name,
                v.status,
                str(v.penalty_amount),
                v.date_time.strftime('%Y-%m-%d'),
            ])

        table = Table(data)
        table.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, 0), colors.grey),
            ('TEXTCOLOR', (0, 0), (-1, 0), colors.whitesmoke),
            ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
            ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
            ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, colors.lightgrey]),
            ('GRID', (0, 0), (-1, -1), 1, colors.black),
        ]))
        elements.append(table)
        doc.build(elements)
        return response


class ExportViolationsExcelView(APIView):
    permission_classes = [IsAdminOrStaff]

    def get(self, request):
        response = HttpResponse(
            content_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        )
        response['Content-Disposition'] = 'attachment; filename="violations.xlsx"'

        wb = openpyxl.Workbook()
        ws = wb.active
        ws.title = "Violations"

        headers = ['ID', 'Violator', 'Violation Type', 'Status', 'Penalty', 'Date']
        for col_num, header in enumerate(headers, 1):
            ws[f'{get_column_letter(col_num)}1'] = header

        violations = Violation.objects.select_related('violation_type', 'enforcer').all()
        for row_num, v in enumerate(violations, 2):
            ws[f'A{row_num}'] = v.violation_id
            ws[f'B{row_num}'] = v.violator_name
            ws[f'C{row_num}'] = v.violation_type.name
            ws[f'D{row_num}'] = v.status
            ws[f'E{row_num}'] = str(v.penalty_amount)
            ws[f'F{row_num}'] = v.date_time.strftime('%Y-%m-%d')

        wb.save(response)
        return response
class AnalyticsView(APIView):
    permission_classes = [IsAdminOrStaff]

    def get(self, request):
        from django.db.models import Count, Sum, Q
        from django.db.models.functions import ExtractHour, ExtractWeekDay, TruncMonth
        from violations.models import Violation
        from accounts.models import CustomUser

        # 1. Violations per hour of day (0-23)
        per_hour = (
            Violation.objects
            .annotate(hour=ExtractHour('date_time'))
            .values('hour')
            .annotate(count=Count('id'))
            .order_by('hour')
        )

        # 2. Violations per day of week (1=Sunday, 7=Saturday)
        per_weekday = (
            Violation.objects
            .annotate(weekday=ExtractWeekDay('date_time'))
            .values('weekday')
            .annotate(count=Count('id'))
            .order_by('weekday')
        )

        weekday_map = {
            1: 'Sunday', 2: 'Monday', 3: 'Tuesday',
            4: 'Wednesday', 5: 'Thursday', 6: 'Friday', 7: 'Saturday'
        }

        # 3. Most common violation type per area (location)
        per_area = (
            Violation.objects
            .values('location', 'violation_type__name')
            .annotate(count=Count('id'))
            .order_by('location', '-count')
        )

        # 4. Collection rate
        total      = Violation.objects.count()
        paid_count = Violation.objects.filter(status=Violation.Status.PAID).count()
        pending    = Violation.objects.filter(status=Violation.Status.PENDING).count()
        collection_rate = round((paid_count / total * 100), 2) if total else 0

        # 5. Enforcer performance
        enforcer_perf = (
            CustomUser.objects
            .filter(role='enforcer')
            .annotate(
                total_violations = Count('enforcer_violations'),
                paid_violations  = Count(
                    'enforcer_violations',
                    filter=Q(enforcer_violations__status=Violation.Status.PAID)
                ),
                total_collected  = Sum(
                    'enforcer_violations__amount_paid',
                    filter=Q(enforcer_violations__status=Violation.Status.PAID)
                ),
            )
            .values('id', 'full_name', 'email',
                    'total_violations', 'paid_violations', 'total_collected')
            .order_by('-total_violations')
        )

        return Response({
            'violations_per_hour':    list(per_hour),
            'violations_per_weekday': [
                {'day': weekday_map.get(x['weekday'], x['weekday']), 'count': x['count']}
                for x in per_weekday
            ],
            'violations_per_area':    list(per_area),
            'collection_rate': {
                'total':           total,
                'paid':            paid_count,
                'pending':         pending,
                'rate_percentage': collection_rate,
            },
            'enforcer_performance':   list(enforcer_perf),
        })