from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework import status, permissions, serializers
from accounts.permissions import IsAdmin, IsEnforcer
from accounts.models import CustomUser
from accounts.serializers import UserSerializer
from .models import EnforcerLocation


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