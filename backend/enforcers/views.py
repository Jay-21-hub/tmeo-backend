from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework import status, permissions, serializers
from django.utils import timezone
from accounts.permissions import IsAdmin, IsEnforcer
from accounts.models import CustomUser
from accounts.serializers import UserSerializer
from audit.utils import log_action
from .models import EnforcerLocation, EnforcerSchedule
from .notifications import send_deployment_notification, send_geofence_alert
import calendar
from datetime import date

# Geofence radius — 500 meters
GEOFENCE_RADIUS_METERS = 500


# ─── Serializers ────────────────────────────────────────────────────────────

class EnforcerLocationSerializer(serializers.ModelSerializer):
    enforcer_detail = UserSerializer(source='enforcer', read_only=True)

    class Meta:
        model  = EnforcerLocation
        fields = '__all__'


class EnforcerScheduleSerializer(serializers.ModelSerializer):
    enforcer_name      = serializers.CharField(source='enforcer.full_name',   read_only=True)
    enforcer_id_number = serializers.CharField(source='enforcer.id_number',   read_only=True)
    created_by_name    = serializers.CharField(source='created_by.full_name', read_only=True)
    shift_type_display = serializers.CharField(source='get_shift_type_display', read_only=True)

    class Meta:
        model  = EnforcerSchedule
        fields = [
            'id', 'enforcer', 'enforcer_name', 'enforcer_id_number',
            'date', 'shift_type', 'shift_type_display',
            'shift_start', 'shift_end', 'assigned_area', 'notes',
            'created_by', 'created_by_name', 'created_at', 'updated_at',
        ]
        read_only_fields = ['id', 'created_by', 'created_at', 'updated_at']


# ─── Enforcer Management ────────────────────────────────────────────────────

class EnforcerListView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        enforcers = CustomUser.objects.filter(role='enforcer', is_active=True)
        return Response(UserSerializer(enforcers, many=True).data)


class DeployEnforcerView(APIView):
    permission_classes = [IsAdmin]

    def post(self, request):
        enforcer_id = request.data.get('enforcer_id')
        area        = request.data.get('area')

        if not enforcer_id or not area:
            return Response(
                {'error': 'enforcer_id and area are required.'},
                status=status.HTTP_400_BAD_REQUEST
            )

        try:
            enforcer = CustomUser.objects.get(
                id=enforcer_id, role='enforcer', is_active=True
            )
        except CustomUser.DoesNotExist:
            return Response(
                {'error': 'Enforcer not found.'},
                status=status.HTTP_404_NOT_FOUND
            )

        try:
            send_deployment_notification(
                enforcer    = enforcer,
                area        = area,
                deployed_by = request.user,
            )
            email_status = 'sent'
        except Exception as e:
            email_status = f'failed: {str(e)}'

        log_action(
            user        = request.user,
            action      = 'DEPLOY',
            module      = 'Enforcers',
            description = f'Deployed {enforcer.full_name} to {area}',
            request     = request,
        )

        return Response({
            'message':      f'{enforcer.full_name} deployed to {area}.',
            'email_status': email_status,
            'enforcer':     UserSerializer(enforcer).data,
        })


# ─── GPS Location ───────────────────────────────────────────────────────────

class LiveLocationsView(APIView):
    permission_classes = [IsAdmin]

    def get(self, request):
        locations = EnforcerLocation.objects.select_related(
            'enforcer'
        ).filter(status='active')
        return Response(EnforcerLocationSerializer(locations, many=True).data)


class UpdateLocationView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def post(self, request):
        if not request.user.is_enforcer:
            return Response(
                {'error': 'Only enforcers can update location.'},
                status=status.HTTP_403_FORBIDDEN
            )

        lat        = request.data.get('latitude')
        lng        = request.data.get('longitude')
        status_val = request.data.get('status', 'active')

        if lat is None or lng is None:
            return Response(
                {'error': 'latitude and longitude are required.'},
                status=status.HTTP_400_BAD_REQUEST
            )

        loc, _ = EnforcerLocation.objects.update_or_create(
            enforcer=request.user,
            defaults={
                'latitude':  lat,
                'longitude': lng,
                'status':    status_val,
            }
        )

        # --- Geofencing check ---
        geofence_triggered = False
        today_schedule = EnforcerSchedule.objects.filter(
            enforcer = request.user,
            date     = timezone.now().date(),
        ).first()

        if today_schedule:
            assigned_loc = EnforcerLocation.objects.filter(
                enforcer = request.user,
                status   = 'active',
            ).first()

            if assigned_loc and today_schedule.assigned_area:
                from .notifications import calculate_distance_meters
                distance = calculate_distance_meters(
                    lat, lng,
                    assigned_loc.latitude,
                    assigned_loc.longitude,
                )

                if distance > GEOFENCE_RADIUS_METERS:
                    geofence_triggered = True
                    try:
                        send_geofence_alert(
                            enforcer        = request.user,
                            current_lat     = lat,
                            current_lon     = lng,
                            assigned_lat    = assigned_loc.latitude,
                            assigned_lon    = assigned_loc.longitude,
                            distance_meters = distance,
                        )
                    except Exception:
                        pass

        return Response({
            **EnforcerLocationSerializer(loc).data,
            'geofence_triggered': geofence_triggered,
        })


# ─── Schedule — Admin ───────────────────────────────────────────────────────

class ScheduleListView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        if not request.user.is_admin:
            return Response(
                {'error': 'Permission denied.'},
                status=status.HTTP_403_FORBIDDEN
            )

        month = request.query_params.get('month', date.today().month)
        year  = request.query_params.get('year',  date.today().year)

        try:
            month = int(month)
            year  = int(year)
        except ValueError:
            return Response(
                {'error': 'Invalid month or year.'},
                status=status.HTTP_400_BAD_REQUEST
            )

        _, last_day = calendar.monthrange(year, month)
        start_date  = date(year, month, 1)
        end_date    = date(year, month, last_day)

        schedules = EnforcerSchedule.objects.filter(
            date__range=[start_date, end_date]
        ).select_related('enforcer', 'created_by').order_by('date', 'shift_start')

        return Response(EnforcerScheduleSerializer(schedules, many=True).data)

    def post(self, request):
        if not request.user.is_admin:
            return Response(
                {'error': 'Permission denied.'},
                status=status.HTTP_403_FORBIDDEN
            )

        serializer = EnforcerScheduleSerializer(data=request.data)
        if serializer.is_valid():
            schedule = serializer.save(created_by=request.user)
            log_action(
                user        = request.user,
                action      = 'CREATE',
                module      = 'Enforcers',
                description = (
                    f'Created schedule for {schedule.enforcer.full_name} '
                    f'on {schedule.date}'
                ),
                request     = request,
            )
            return Response(
                EnforcerScheduleSerializer(schedule).data,
                status=status.HTTP_201_CREATED
            )
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)


class ScheduleDetailView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def get_object(self, pk):
        try:
            return EnforcerSchedule.objects.select_related(
                'enforcer', 'created_by'
            ).get(pk=pk)
        except EnforcerSchedule.DoesNotExist:
            return None

    def get(self, request, pk):
        schedule = self.get_object(pk)
        if not schedule:
            return Response({'error': 'Schedule not found.'}, status=status.HTTP_404_NOT_FOUND)
        return Response(EnforcerScheduleSerializer(schedule).data)

    def patch(self, request, pk):
        if not request.user.is_admin:
            return Response({'error': 'Permission denied.'}, status=status.HTTP_403_FORBIDDEN)
        schedule = self.get_object(pk)
        if not schedule:
            return Response({'error': 'Schedule not found.'}, status=status.HTTP_404_NOT_FOUND)
        serializer = EnforcerScheduleSerializer(schedule, data=request.data, partial=True)
        if serializer.is_valid():
            serializer.save()
            log_action(
                user        = request.user,
                action      = 'UPDATE',
                module      = 'Enforcers',
                description = f'Updated schedule for {schedule.enforcer.full_name} on {schedule.date}',
                request     = request,
            )
            return Response(EnforcerScheduleSerializer(schedule).data)
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

    def delete(self, request, pk):
        if not request.user.is_admin:
            return Response({'error': 'Permission denied.'}, status=status.HTTP_403_FORBIDDEN)
        schedule = self.get_object(pk)
        if not schedule:
            return Response({'error': 'Schedule not found.'}, status=status.HTTP_404_NOT_FOUND)
        name = schedule.enforcer.full_name
        day  = schedule.date
        schedule.delete()
        log_action(
            user        = request.user,
            action      = 'DELETE',
            module      = 'Enforcers',
            description = f'Deleted schedule for {name} on {day}',
            request     = request,
        )
        return Response({'message': 'Schedule deleted.'})


# ─── Schedule — Enforcer (own schedule) ────────────────────────────────────

class MyScheduleView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        if not request.user.is_enforcer:
            return Response(
                {'error': 'Only enforcers can view their schedule.'},
                status=status.HTTP_403_FORBIDDEN
            )

        month = request.query_params.get('month', date.today().month)
        year  = request.query_params.get('year',  date.today().year)

        try:
            month = int(month)
            year  = int(year)
        except ValueError:
            return Response(
                {'error': 'Invalid month or year.'},
                status=status.HTTP_400_BAD_REQUEST
            )

        _, last_day = calendar.monthrange(year, month)
        start_date  = date(year, month, 1)
        end_date    = date(year, month, last_day)

        schedules = EnforcerSchedule.objects.filter(
            enforcer    = request.user,
            date__range = [start_date, end_date]
        ).order_by('date', 'shift_start')

        return Response(EnforcerScheduleSerializer(schedules, many=True).data)