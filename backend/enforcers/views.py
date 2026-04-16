from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework import status, permissions, serializers
from accounts.permissions import IsAdmin, IsEnforcer
from accounts.models import CustomUser
from accounts.serializers import UserSerializer
from audit.utils import log_action
from .models import EnforcerLocation
from .notifications import send_deployment_notification


class EnforcerLocationSerializer(serializers.ModelSerializer):
    enforcer_detail = UserSerializer(source='enforcer', read_only=True)

    class Meta:
        model  = EnforcerLocation
        fields = '__all__'


class EnforcerListView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        enforcers = CustomUser.objects.filter(
            role='enforcer', is_active=True
        )
        return Response(UserSerializer(enforcers, many=True).data)


class LiveLocationsView(APIView):
    permission_classes = [IsAdmin]

    def get(self, request):
        locations = EnforcerLocation.objects.select_related(
            'enforcer'
        ).filter(status='active')
        return Response(
            EnforcerLocationSerializer(locations, many=True).data
        )


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
                'status':    status_val
            }
        )
        return Response(EnforcerLocationSerializer(loc).data)


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

        # Send email notification
        try:
            send_deployment_notification(
                enforcer    = enforcer,
                area        = area,
                deployed_by = request.user,
            )
            email_status = 'sent'
        except Exception as e:
            email_status = f'failed: {str(e)}'

        # Log the deployment
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