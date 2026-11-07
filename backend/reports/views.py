from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework.permissions import IsAuthenticated
from accounts.permissions import IsAdminOrStaff
from django.utils import timezone
from django.db.models import Count, Sum

from violations.models import Violation
from accounts.identity import latest_enforcer_snapshots, grouped_enforcer_identity


class ViolationByTypeView(APIView):
    """
    Violation by Type — pie/donut chart data
    Distribution of violation categories
    """
    permission_classes = [IsAuthenticated, IsAdminOrStaff]

    def get(self, request):
        from violations.models import ViolationItem  
        data = (
            ViolationItem.objects
            .values('violation_type__name', 'violation_type__category')
            .annotate(count=Count('id'))
            .order_by('-count')
        )
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
    permission_classes = [IsAuthenticated, IsAdminOrStaff]

    def get(self, request):
        import calendar
        from datetime import date as date_type

        today  = timezone.now()
        months = []

        for i in range(6, -1, -1):
            month_offset = today.month - i
            year  = today.year + (month_offset - 1) // 12
            month = ((month_offset - 1) % 12) + 1

            month_start = date_type(year, month, 1)
            month_end   = date_type(year, month, calendar.monthrange(year, month)[1])

            count = Violation.objects.filter(
                created_at__date__gte=month_start,
                created_at__date__lte=month_end,
            ).count()

            months.append({
                'month': month_start.strftime('%b %Y'),
                'count': count,
            })

        return Response(months)
class ViolationHotspotsView(APIView):
    """
    Violation Hotspots —
    Top 3 locations with most violations
    """
    permission_classes = [IsAuthenticated, IsAdminOrStaff]

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
    permission_classes = [IsAuthenticated, IsAdminOrStaff]

    def get(self, request):
        today       = timezone.now()
        month_start = today.replace(day=1).date()

        data = list(Violation.objects.filter(
            created_at__date__gte=month_start,
        ).values(
            'enforcer__full_name',
            'enforcer__id',
        ).annotate(
            ticket_count=Count('id')
        ).order_by('-ticket_count', 'enforcer__id')[:3])

        # Phase 3: stable-id grouping; name = latest event-time name (live
        # name only as fallback); badge = snapshot-only, null when none.
        snaps = latest_enforcer_snapshots([i['enforcer__id'] for i in data])
        out = []
        for item in data:
            ident = grouped_enforcer_identity(item['enforcer__id'], item['enforcer__full_name'], snaps)
            out.append({
                'id':           item['enforcer__id'],
                'name':         ident['name'],
                'badge_number': ident['badge'] or None,
                'ticket_count': item['ticket_count'],
            })
        return Response(out)


class CollectionSummaryView(APIView):
    """
    Collection Summary —
    Revenue from penalties this month
    """
    permission_classes = [IsAuthenticated, IsAdminOrStaff]

    def get(self, request):
        today       = timezone.now()
        month_start = today.replace(day=1).date()

        monthly = Violation.objects.filter(
            created_at__date__gte=month_start
        )

        total_collected = monthly.filter(
            status='paid'
        ).aggregate(
            total=Sum('penalty_amount') 
        )['total'] or 0

        pending_payments = monthly.filter(
            status__in=['pending', 'processing']
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
    GET /api/reports/generate/?type=<report>&date_from=&date_to=&...

    Thin HTTP wrapper — all report logic lives in reports/services/.
    Response: {meta, summary, rows}. `meta.columns` describes the table so
    the on-screen table and the PDF render from one definition, and
    `meta.filters_applied` echoes exactly the filters that were applied.
    Invalid input returns 400 with {"error": "..."} (never a silent empty).
    """
    permission_classes = [IsAuthenticated, IsAdminOrStaff]

    def get(self, request):
        from .services import FilterError, generate_report
        try:
            payload = generate_report(request.query_params.get('type', ''), request.query_params, request.user)
        except FilterError as exc:
            return Response({'error': str(exc)}, status=400)
        return Response(payload)


import openpyxl
from openpyxl.utils import get_column_letter
from reportlab.lib.pagesizes import letter
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib import colors
from django.http import HttpResponse
class ExportViolationsPDFView(APIView):
    permission_classes = [IsAdminOrStaff]

    def get(self, request):
        response = HttpResponse(content_type='application/pdf')
        response['Content-Disposition'] = 'attachment; filename="violations.pdf"'

        doc = SimpleDocTemplate(response, pagesize=letter)
        styles = getSampleStyleSheet()
        elements = []
        elements.append(Paragraph("Violations Report", styles['Title']))

        violations = (
            Violation.objects
            .prefetch_related('items__violation_type')  
            .select_related('enforcer')
            .all()
        )

        data = [['ID', 'Violator', 'Violation Type', 'Status', 'Penalty', 'Date']]
        for v in violations:
            vtype = ', '.join(
                i.violation_type.name for i in v.items.all() if i.violation_type
            ) or '—'
            data.append([
                str(v.id),                                        
                v.violator_name,
                vtype,                                            
                v.status,
                str(v.penalty_amount),
                v.date_issued.strftime('%Y-%m-%d') if v.date_issued else '—',  
            ])

        table = Table(data)
        table.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, 0), colors.grey),
            ('TEXTCOLOR', (0, 0), (-1, 0), colors.whitesmoke),
            ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
            ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
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

        violations = (
            Violation.objects
            .prefetch_related('items__violation_type')  
            .select_related('enforcer')
            .all()
        )
        for row_num, v in enumerate(violations, 2):
            vtype = ', '.join(
                i.violation_type.name for i in v.items.all() if i.violation_type
            ) or '—'
            ws[f'A{row_num}'] = str(v.id)                                         
            ws[f'B{row_num}'] = v.violator_name
            ws[f'C{row_num}'] = vtype                                               
            ws[f'D{row_num}'] = v.status
            ws[f'E{row_num}'] = str(v.penalty_amount)
            ws[f'F{row_num}'] = v.date_issued.strftime('%Y-%m-%d') if v.date_issued else '—'  

        wb.save(response)
        return response