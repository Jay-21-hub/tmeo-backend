"""
Token refresh that refuses refresh tokens issued for a previous role/ID
(Role Evolution, Phase 5). Kept apart from accounts.authentication because
that module is imported while DRF settings load, and importing simplejwt's
views there would be circular. See accounts.authentication for the design.
"""
from rest_framework_simplejwt.exceptions import InvalidToken
from rest_framework_simplejwt.serializers import TokenRefreshSerializer
from rest_framework_simplejwt.settings import api_settings
from rest_framework_simplejwt.views import TokenRefreshView

from .authentication import SESSION_INVALIDATED_MESSAGE, token_matches_account


class TMEOTokenRefreshSerializer(TokenRefreshSerializer):
    def validate(self, attrs):
        from .models import CustomUser
        try:
            refresh = self.token_class(attrs['refresh'])
        except Exception:
            # Let the stock implementation produce its normal InvalidToken error.
            return super().validate(attrs)
        user = CustomUser.objects.filter(
            **{api_settings.USER_ID_FIELD: refresh.payload.get(api_settings.USER_ID_CLAIM)}
        ).first()
        if user is not None and not token_matches_account(refresh.payload, user):
            raise InvalidToken(SESSION_INVALIDATED_MESSAGE)
        return super().validate(attrs)


class TMEOTokenRefreshView(TokenRefreshView):
    serializer_class = TMEOTokenRefreshSerializer