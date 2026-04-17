from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework import status, permissions
from rest_framework_simplejwt.tokens import RefreshToken
from django.utils import timezone
from django.core.mail import send_mail
from django.conf import settings
from django.contrib.auth.tokens import default_token_generator
from django.utils.encoding import force_bytes, force_str
from django.utils.http import urlsafe_base64_encode, urlsafe_base64_decode
from audit.utils import log_action

from .models import CustomUser
from .serializers import (
    AdminCreateUserSerializer,
    LoginSerializer,
    UserSerializer,
    UpdateUserSerializer,
    UpdateDutyStatusSerializer,
    ChangePasswordSerializer,
    ForgotPasswordSerializer,
    ResetPasswordSerializer,
)


def get_tokens(user):
    refresh = RefreshToken.for_user(user)
    refresh['role']              = user.role
    refresh['full_name']         = user.full_name
    refresh['id_number']         = user.id_number
    refresh['employment_status'] = user.employment_status
    return {
        'refresh': str(refresh),
        'access':  str(refresh.access_token),
    }


def get_redirect(role):
    return {
        'admin':    '/admin/dashboard',
        'staff':    '/staff/dashboard',
        'enforcer': '/enforcer/dashboard',
    }.get(role, '/dashboard')


class LoginView(APIView):
    permission_classes = [permissions.AllowAny]

    def post(self, request):
        serializer = LoginSerializer(data=request.data)
        if serializer.is_valid():
            user = serializer.validated_data['user']
            user.last_login = timezone.now()
            user.save(update_fields=['last_login'])
            log_action(
                user        = user,
                action      = 'LOGIN',
                module      = 'Accounts',
                description = f'{user.email} logged in',
                request     = request,
            )
            return Response({
                'message':  'Login successful.',
                'user':     UserSerializer(user).data,
                'tokens':   get_tokens(user),
                'redirect': get_redirect(user.role),
            })
        return Response(
            serializer.errors,
            status=status.HTTP_400_BAD_REQUEST
        )


class LogoutView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def post(self, request):
        try:
            refresh_token = request.data.get('refresh')
            if not refresh_token:
                return Response(
                    {'error': 'Refresh token is required.'},
                    status=status.HTTP_400_BAD_REQUEST
                )
            token = RefreshToken(refresh_token)
            token.blacklist()
            log_action(
                user        = request.user,
                action      = 'LOGOUT',
                module      = 'Accounts',
                description = f'{request.user.email} logged out',
                request     = request,
            )
            return Response({'message': 'Logged out successfully.'})
        except Exception:
            return Response(
                {'error': 'Invalid or expired token.'},
                status=status.HTTP_400_BAD_REQUEST
            )


class MeView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        return Response(UserSerializer(request.user).data)

    def patch(self, request):
        serializer = UpdateUserSerializer(
            request.user,
            data=request.data,
            partial=True
        )
        if serializer.is_valid():
            serializer.save()
            log_action(
                user        = request.user,
                action      = 'UPDATE',
                module      = 'Accounts',
                description = f'{request.user.email} updated their profile',
                request     = request,
            )
            return Response({
                'message': 'Profile updated.',
                'user':    UserSerializer(request.user).data,
            })
        return Response(
            serializer.errors,
            status=status.HTTP_400_BAD_REQUEST
        )


class ChangePasswordView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def post(self, request):
        serializer = ChangePasswordSerializer(data=request.data)
        if serializer.is_valid():
            user = request.user
            if not user.check_password(
                serializer.validated_data['old_password']
            ):
                return Response(
                    {'old_password': 'Current password is incorrect.'},
                    status=status.HTTP_400_BAD_REQUEST
                )
            user.set_password(serializer.validated_data['new_password'])
            user.save()
            log_action(
                user        = request.user,
                action      = 'UPDATE',
                module      = 'Accounts',
                description = f'{request.user.email} changed their password',
                request     = request,
            )
            return Response({'message': 'Password changed successfully.'})
        return Response(
            serializer.errors,
            status=status.HTTP_400_BAD_REQUEST
        )


class ForgotPasswordView(APIView):
    permission_classes = [permissions.AllowAny]

    def post(self, request):
        serializer = ForgotPasswordSerializer(data=request.data)
        if serializer.is_valid():
            email = serializer.validated_data['email']
            try:
                user  = CustomUser.objects.get(email=email)
                uid   = urlsafe_base64_encode(force_bytes(user.pk))
                token = default_token_generator.make_token(user)

                # Build reset link — frontend URL
                reset_link = (
                    f"{settings.FRONTEND_URL}/reset-password"
                    f"?uid={uid}&token={token}"
                )

                send_mail(
                    subject    = 'TMEO — Password Reset Request',
                    message    = (
                        f'Hello {user.full_name},\n\n'
                        f'Click the link below to reset your password:\n'
                        f'{reset_link}\n\n'
                        f'This link expires in 24 hours.\n\n'
                        f'If you did not request this, ignore this email.'
                    ),
                    from_email = settings.DEFAULT_FROM_EMAIL,
                    recipient_list = [email],
                    fail_silently  = True,
                )
            except CustomUser.DoesNotExist:
                pass  # Silent — don't reveal if email exists

            # Always return success for security
            return Response({
                'message': (
                    'If this email is registered, '
                    'a password reset link has been sent.'
                )
            })
        return Response(
            serializer.errors,
            status=status.HTTP_400_BAD_REQUEST
        )


class ResetPasswordView(APIView):
    permission_classes = [permissions.AllowAny]

    def post(self, request):
        serializer = ResetPasswordSerializer(data=request.data)
        if serializer.is_valid():
            try:
                uid  = force_str(
                    urlsafe_base64_decode(serializer.validated_data['token'])
                )
                # token field actually contains uid — get real token from body
                uid   = force_str(
                    urlsafe_base64_decode(request.data.get('uid', ''))
                )
                token = request.data.get('token', '')
                user  = CustomUser.objects.get(pk=uid)

                if not default_token_generator.check_token(user, token):
                    return Response(
                        {'error': 'Invalid or expired reset link.'},
                        status=status.HTTP_400_BAD_REQUEST
                    )

                user.set_password(
                    serializer.validated_data['new_password']
                )
                user.save()
                return Response(
                    {'message': 'Password reset successful. You may now log in.'}
                )
            except (CustomUser.DoesNotExist, ValueError):
                return Response(
                    {'error': 'Invalid reset link.'},
                    status=status.HTTP_400_BAD_REQUEST
                )
        return Response(
            serializer.errors,
            status=status.HTTP_400_BAD_REQUEST
        )


class UserListView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        if not request.user.is_admin:
            return Response(
                {'error': 'Permission denied.'},
                status=status.HTTP_403_FORBIDDEN
            )
        role              = request.query_params.get('role')
        employment_status = request.query_params.get('employment_status')
        users             = CustomUser.objects.all().order_by('full_name')
        if role:
            users = users.filter(role=role)
        if employment_status:
            users = users.filter(employment_status=employment_status)
        return Response(UserSerializer(users, many=True).data)

    def post(self, request):
        if not request.user.is_admin:
            return Response(
                {'error': 'Permission denied.'},
                status=status.HTTP_403_FORBIDDEN
            )
        serializer = AdminCreateUserSerializer(data=request.data)
        if serializer.is_valid():
            user = serializer.save()

            # Send credentials via email
            send_mail(
                subject    = 'TMEO — Your Account Has Been Created',
                message    = (
                    f'Hello {user.full_name},\n\n'
                    f'Your TMEO account has been created.\n\n'
                    f'Employee ID : {user.id_number}\n'
                    f'Email       : {user.email}\n'
                    f'Role        : {user.get_role_display()}\n'
                    f'Password    : {user._temp_password}\n\n'
                    f'Please change your password after your first login.\n\n'
                    f'— TMEO System Administrator'
                ),
                from_email     = settings.DEFAULT_FROM_EMAIL,
                recipient_list = [user.email],
                fail_silently  = True,
            )

            log_action(
                user        = request.user,
                action      = 'CREATE',
                module      = 'Accounts',
                description = (
                    f'Created new {user.role} account: '
                    f'{user.email} ({user.id_number})'
                ),
                request     = request,
            )
            return Response(
                UserSerializer(user).data,
                status=status.HTTP_201_CREATED
            )
        return Response(
            serializer.errors,
            status=status.HTTP_400_BAD_REQUEST
        )


class UserDetailView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def get_object(self, pk):
        try:
            return CustomUser.objects.get(pk=pk)
        except CustomUser.DoesNotExist:
            return None

    def get(self, request, pk):
        if not request.user.is_admin:
            return Response(
                {'error': 'Permission denied.'},
                status=status.HTTP_403_FORBIDDEN
            )
        user = self.get_object(pk)
        if not user:
            return Response(
                {'error': 'User not found.'},
                status=status.HTTP_404_NOT_FOUND
            )
        return Response(UserSerializer(user).data)

    def patch(self, request, pk):
        if not request.user.is_admin:
            return Response(
                {'error': 'Permission denied.'},
                status=status.HTTP_403_FORBIDDEN
            )
        user = self.get_object(pk)
        if not user:
            return Response(
                {'error': 'User not found.'},
                status=status.HTTP_404_NOT_FOUND
            )
        serializer = UpdateUserSerializer(
            user, data=request.data, partial=True
        )
        if serializer.is_valid():
            old_status = user.employment_status
            serializer.save()

            # If employment status changed to separated — deactivate
            if (
                user.employment_status != old_status
                and user.is_separated
            ):
                user.is_active   = False
                user.duty_status = CustomUser.DutyStatus.OFF_DUTY
                user.save(update_fields=['is_active', 'duty_status'])

            log_action(
                user        = request.user,
                action      = 'UPDATE',
                module      = 'Accounts',
                description = f'Updated account: {user.email}',
                request     = request,
            )
            return Response(UserSerializer(user).data)
        return Response(
            serializer.errors,
            status=status.HTTP_400_BAD_REQUEST
        )

    def delete(self, request, pk):
        if not request.user.is_admin:
            return Response(
                {'error': 'Permission denied.'},
                status=status.HTTP_403_FORBIDDEN
            )
        user = self.get_object(pk)
        if not user:
            return Response(
                {'error': 'User not found.'},
                status=status.HTTP_404_NOT_FOUND
            )
        user.is_active        = False
        user.employment_status = CustomUser.EmploymentStatus.TERMINATED
        user.duty_status       = CustomUser.DutyStatus.OFF_DUTY
        user.save(update_fields=[
            'is_active', 'employment_status', 'duty_status'
        ])
        log_action(
            user        = request.user,
            action      = 'DELETE',
            module      = 'Accounts',
            description = f'Terminated account: {user.email}',
            request     = request,
        )
        return Response(
            {'message': f'{user.full_name} has been terminated.'}
        )


class UpdateDutyStatusView(APIView):
    """Enforcer updates their own duty status (On Duty / On Break)."""
    permission_classes = [permissions.IsAuthenticated]

    def post(self, request):
        if not request.user.is_enforcer:
            return Response(
                {'error': 'Only enforcers can update duty status.'},
                status=status.HTTP_403_FORBIDDEN
            )
        serializer = UpdateDutyStatusSerializer(
            data    = request.data,
            context = {'user': request.user}
        )
        if serializer.is_valid():
            new_status = serializer.validated_data['duty_status']
            user       = request.user
            now        = timezone.now()

            user.duty_status            = new_status
            user.duty_status_updated_at = now

            if new_status == CustomUser.DutyStatus.ON_BREAK:
                user.break_started_at = now
            elif new_status == CustomUser.DutyStatus.ON_DUTY:
                user.break_started_at = None

            user.save(update_fields=[
                'duty_status',
                'duty_status_updated_at',
                'break_started_at',
            ])
            log_action(
                user        = request.user,
                action      = 'UPDATE',
                module      = 'Accounts',
                description = (
                    f'{user.full_name} updated duty status to '
                    f'{user.get_duty_status_display()}'
                ),
                request     = request,
            )
            return Response({
                'message':    f'Duty status updated to {user.get_duty_status_display()}.',
                'duty_status': new_status,
                'updated_at':  now,
            })
        return Response(
            serializer.errors,
            status=status.HTTP_400_BAD_REQUEST
        )

class UpdateFCMTokenView(APIView):
    """
    POST /api/accounts/fcm-token/
    Enforcer/any user — saves their device FCM token for push notifications.
    Called once after login from the mobile app.
    """
    permission_classes = [permissions.IsAuthenticated]

    def post(self, request):
        token = request.data.get('fcm_token', '').strip()
        if not token:
            return Response(
                {'error': 'fcm_token is required.'},
                status=status.HTTP_400_BAD_REQUEST
            )
        request.user.fcm_token = token
        request.user.save(update_fields=['fcm_token'])
        return Response({'message': 'FCM token updated.'})