from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework.throttling import AnonRateThrottle

class LoginThrottle(AnonRateThrottle):
    # Per-IP, generous: many users can share one school/office WiFi.
    scope = 'login'
    rate = '300/minute'


class LoginAccountThrottle(AnonRateThrottle):
    # Per-account, strict: keeps brute-force protection on a single username.
    scope = 'login_account'
    rate = '10/minute'

    def get_cache_key(self, request, view):
        ident = str(request.data.get('id_number') or '').strip().lower()
        if not ident:
            return None
        return self.cache_format % {'scope': self.scope, 'ident': ident}


class ForgotPasswordThrottle(AnonRateThrottle):
    # Each accepted request can send an email, so the global 20/min anonymous limit let
    # one client mail-bomb a single account at ~1,200 emails/hour. Per-IP, own bucket.
    scope = 'forgot_password'
    rate = '10/hour'


class ResetPasswordThrottle(AnonRateThrottle):
    scope = 'reset_password'
    rate = '20/hour'
from rest_framework import status, permissions
from rest_framework_simplejwt.tokens import RefreshToken
from rest_framework_simplejwt.exceptions import TokenError
from django.utils import timezone
from django.db import transaction
from django.db.models.deletion import ProtectedError
from django.core.mail import send_mail
from django.conf import settings
from django.contrib.auth.tokens import default_token_generator
from django.utils.encoding import force_bytes, force_str
from django.utils.http import urlsafe_base64_encode, urlsafe_base64_decode
from audit.utils import log_action, build_changes, snapshot

from .models import CustomUser
from .history_guard import get_user_historical_references, HISTORY_BLOCK_MESSAGE
from .services import change_user_role, RoleChangeError
from .serializers import (
    AdminCreateUserSerializer,
    LoginSerializer,
    UserSerializer,
    UpdateUserSerializer,
    SelfUpdateUserSerializer,
    UpdateDutyStatusSerializer,
    ChangePasswordSerializer,
    ResetPasswordSerializer,
)

import logging
import threading
logger = logging.getLogger(__name__)


def _send_reset_email(user_id, recipient, message):
    """Runs in a background thread. Never raises; logs only the error class and user id
    (smtplib exception text can contain the recipient address)."""
    try:
        send_mail(
            subject='TMEO — Password Reset Request',
            message=message,
            from_email=settings.DEFAULT_FROM_EMAIL,
            recipient_list=[recipient],
        )
    except Exception as exc:
        # SMTP down/blocked/misconfigured. The admin "reset password" action is the fallback.
        logger.error('Password reset email failed for user_id=%s (%s)', user_id, type(exc).__name__)


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


def _cleanup_old_photo(user, old_photo_name):
    """
    Deletes a user's previous profile photo from storage after it has
    been replaced or removed.

    IMPORTANT: `old_photo_name` must be captured as a plain string
    BEFORE serializer.save() runs. `user.profile_photo` is a FieldFile
    bound live to the instance, so reading it again after save() just
    returns the new value — comparing "before" and "after" off the same
    live attribute always compares a value to itself.
    """
    if not old_photo_name:
        return
    new_photo = user.profile_photo
    new_name  = new_photo.name if new_photo else None
    if old_photo_name != new_name:
        try:
            new_photo.storage.delete(old_photo_name)
        except Exception:
            # Never let storage cleanup failures break the actual update.
            pass


def get_redirect(role):
    return {
        'admin':    '/admin/dashboard',
        'staff':    '/staff/dashboard',
        'enforcer': '/enforcer/dashboard',
    }.get(role, '/dashboard')


class LoginView(APIView):
    permission_classes = [permissions.AllowAny]
    throttle_classes = [LoginThrottle, LoginAccountThrottle]

    def post(self, request):
        serializer = LoginSerializer(data=request.data)
        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

        user     = serializer.validated_data['user']
        tokens   = get_tokens(user)
        redirect = get_redirect(user.role)

        log_action(
            user        = user,
            action      = 'LOGIN',
            module      = 'Accounts',
            description = f'{user.full_name} logged in',
            request     = request,
            target_type = 'User',
            target_id   = user.id,
            details     = {
                'full_name': user.full_name,
                'email':     user.email,
                'role':      user.role,
                'badge_no':  user.badge_number or None,
            },
        )

        return Response({
            'access':   tokens['access'],
            'refresh':  tokens['refresh'],
            'redirect': redirect,
            'user':     UserSerializer(user).data,
        })

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
            try:
                token = RefreshToken(refresh_token)
                token.blacklist()
            except TokenError:
                return Response(
                    {'error': 'Refresh token is invalid or already blacklisted.'},
                    status=status.HTTP_400_BAD_REQUEST
                )
            log_action(
                user        = request.user,
                action      = 'LOGOUT',
                module      = 'Accounts',
                description = f'{request.user.email} logged out',
                request     = request,
                target_type = 'User',
                target_id   = request.user.id,
                details     = {
                    'full_name': request.user.full_name,
                    'email':     request.user.email,
                    'role':      request.user.role,
                },
            )
            return Response({'detail': 'Successfully logged out.'}, status=status.HTTP_200_OK)
        except Exception:
            return Response(
                {'error': 'An error occurred during logout.'},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR
            )


class MeView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        return Response(UserSerializer(request.user).data)

    def patch(self, request):
        before = snapshot(request.user, ('full_name', 'email', 'phone_number'))
        old_photo_name = (
            request.user.profile_photo.name
            if 'profile_photo' in request.data and request.user.profile_photo
            else None
        )
        serializer = SelfUpdateUserSerializer(
            request.user,
            data=request.data,
            partial=True
        )
        if serializer.is_valid():
            serializer.save()
            _cleanup_old_photo(request.user, old_photo_name)
            after = snapshot(request.user, ('full_name', 'email', 'phone_number'))
            log_action(
                user        = request.user,
                action      = 'UPDATE',
                module      = 'Accounts',
                description = f'{request.user.email} updated their profile',
                request     = request,
                target_type = 'User',
                target_id   = request.user.id,
                changes     = build_changes(before, after),
                details     = {
                    'full_name': request.user.full_name,
                    'email':     request.user.email,
                    'role':      request.user.role,
                    'action':    'Self profile update',
                },
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
                target_type = 'User',
                target_id   = request.user.id,
                details     = {
                    'full_name': request.user.full_name,
                    'email':     request.user.email,
                    'role':      request.user.role,
                    'action':    'Password changed',
                },
            )
            return Response({'message': 'Password changed successfully.'})
        return Response(
            serializer.errors,
            status=status.HTTP_400_BAD_REQUEST
        )


class ForgotPasswordView(APIView):
    """
    Always answers the same way for a well-formed request ({'detail': 'sent'}, 200),
    whether or not the ID exists, has an email, or the mail could be delivered.
    Distinct answers would let anyone enumerate valid ID numbers (and which of them
    have no email on file). Problems are logged server-side instead.
    """
    permission_classes = [permissions.AllowAny]
    throttle_classes = [ForgotPasswordThrottle]

    def post(self, request):
        raw_username = request.data.get('username', '')
        username = raw_username.strip() if isinstance(raw_username, str) else ''
        if not username:
            return Response({'detail': 'Username is required.'}, status=400)

        try:
            user = CustomUser.objects.get(id_number=username)
        except CustomUser.DoesNotExist:
            return Response({'detail': 'sent'})

        if not user.email:
            logger.warning('Password reset requested for user_id=%s but no email is on file.', user.pk)
            return Response({'detail': 'sent'})

        uid   = urlsafe_base64_encode(force_bytes(user.pk))
        token = default_token_generator.make_token(user)
        reset_link = f"{settings.FRONTEND_URL}/reset-password/{uid}/{token}/"

        message = (
            f"Hi {user.full_name},\n\n"
            f"A password reset was requested for your TMEO account.\n\n"
            f"Click this link to reset your password:\n{reset_link}\n\n"
            f"This link expires in 24 hours.\n\n"
            f"If you did not request this, you can safely ignore this email."
        )
        # Sent from a background thread so the response time is the same whether or not an
        # email goes out (no timing oracle) and a slow/blocked SMTP server never pins a
        # gunicorn thread for the request.
        threading.Thread(
            target=_send_reset_email,
            args=(user.pk, user.email, message),
            daemon=True,
        ).start()
        return Response({'detail': 'sent'})


class ResetPasswordView(APIView):
    permission_classes = [permissions.AllowAny]
    throttle_classes = [ResetPasswordThrottle]

    def post(self, request):
        serializer = ResetPasswordSerializer(data=request.data)
        if serializer.is_valid():
            try:
                raw_uid = request.data.get('uid', '')
                # Non-string uid/token (JSON numbers, lists...) used to raise
                # AttributeError -> HTTP 500; they are simply an invalid link.
                if not isinstance(raw_uid, str):
                    raise ValueError('uid must be a string')
                uid   = force_str(urlsafe_base64_decode(raw_uid))
                token = serializer.validated_data['token']
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
            except (CustomUser.DoesNotExist, ValueError, OverflowError):
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
        search            = request.query_params.get('search')
        users             = CustomUser.objects.all().order_by('full_name')
        if role:
            users = users.filter(role=role)

        if employment_status:
            users = users.filter(employment_status=employment_status)

        if search:
            from django.db.models import Q
            users = users.filter(
                Q(full_name__icontains=search)  |
                Q(email__icontains=search)      |
                Q(id_number__icontains=search)
            )
        all_users = CustomUser.objects.filter(is_active=True)
        return Response({
            'results': UserSerializer(users, many=True).data,
            'count':   users.count(),
            'stats': {
                'total_users':      all_users.count(),
                'total_enforcers':  all_users.filter(role='enforcer').count(),
                'assessment_staff': all_users.filter(role='staff').count(),
                'administrators':   all_users.filter(role='admin').count(),
            }
        })

    def post(self, request):
        if not request.user.is_admin:
            return Response(
                {'error': 'Permission denied.'},
                status=status.HTTP_403_FORBIDDEN
            )
        serializer = AdminCreateUserSerializer(data=request.data)
        if serializer.is_valid():
            user = serializer.save()
            log_action(
                user        = request.user,
                action      = 'CREATE',
                module      = 'User Management',
                description = f'Created new user: {user.full_name} ({user.role})',
                request     = request,
                target_type = 'User',
                target_id   = user.id,
                details     = {
                    'full_name':   user.full_name,
                    'email':       user.email,
                    'role':        user.role,
                    'badge_no':    user.badge_number or None,
                    'hired_year':  str(user.hired_year) if user.hired_year else None,
                    'phone':       user.phone_number or None,
                },
            )
            return Response(
                UserSerializer(user).data,
                status=status.HTTP_201_CREATED
            )
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
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
        if 'duty_status' in request.data or 'status' in request.data:
            return Response(
                {'duty_status': 'Duty status is calculated from the duty schedule and cannot be changed here.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        # Inactive, or no longer employed as active: only reactivation is allowed.
        locked = (
            not user.is_active
            or user.employment_status != CustomUser.EmploymentStatus.ACTIVE
        )
        if locked:
            extra = set(request.data.keys()) - {'employment_status'}
            if extra or request.data.get('employment_status') != CustomUser.EmploymentStatus.ACTIVE:
                return Response(
                    {'detail': 'This account is inactive. The only change allowed is reactivation to Active.'},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            user.employment_status = CustomUser.EmploymentStatus.ACTIVE
            user.is_active = True
            user.save(update_fields=['employment_status', 'is_active'])
            log_action(
                user        = request.user,
                action      = 'UPDATE',
                module      = 'Accounts',
                description = f'Reactivated account: {user.email}',
                request     = request,
                target_type = 'User',
                target_id   = user.id,
                details     = {
                    'target_user': user.full_name,
                    'email':       user.email,
                    'role':        user.role,
                    'emp_status':  user.employment_status,
                    'updated_by':  request.user.full_name,
                },
            )
            return Response(UserSerializer(user).data)
        before = snapshot(user, ('full_name', 'email', 'role', 'employment_status', 'duty_status', 'badge_number'))
        old_photo_name = (
            user.profile_photo.name
            if 'profile_photo' in request.data and user.profile_photo
            else None
        )
        serializer = UpdateUserSerializer(
            user, data=request.data, partial=True
        )
        if serializer.is_valid():
            old_status = user.employment_status
            serializer.save()
            _cleanup_old_photo(user, old_photo_name)

            # If employment status changed to separated — deactivate
            if (
                user.employment_status != old_status
                and user.is_separated
            ):
                user.is_active   = False
                user.duty_status = CustomUser.DutyStatus.OFF_DUTY
                user.save(update_fields=['is_active', 'duty_status'])

            after = snapshot(user, ('full_name', 'email', 'role', 'employment_status', 'duty_status', 'badge_number'))

            log_action(
                user        = request.user,
                action      = 'UPDATE',
                module      = 'Accounts',
                description = f'Updated account: {user.email}',
                request     = request,
                target_type = 'User',
                target_id   = user.id,
                changes     = build_changes(before, after),
                details     = {
                    'target_user':  user.full_name,
                    'email':        user.email,
                    'role':         user.role,
                    'badge_no':     user.badge_number or None,
                    'emp_status':   user.employment_status,
                    'updated_by':   request.user.full_name,
                },
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
            target_type = 'User',
            target_id   = user.id,
            details     = {
                'target_user': user.full_name,
                'email':       user.email,
                'role':        user.role,
                'badge_no':    user.badge_number or None,
                'terminated_by': request.user.full_name,
            },
        )
        return Response(
            {'message': f'{user.full_name} has been terminated.'}
        )
class UpdateDutyStatusView(APIView):
    """
    Legacy endpoint kept for client compatibility.

    Duty status is SERVER-COMPUTED from today's EnforcerSchedule + current local
    time (enforcers.duty.compute_duty). A requested `duty_status` is accepted
    (and echoed as `requested`) but never authoritative: the computed value is
    mirrored onto CustomUser.duty_status and returned as `duty_status`.
    """
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
        if not serializer.is_valid():
            return Response(
                serializer.errors,
                status=status.HTTP_400_BAD_REQUEST
            )

        from enforcers.duty import compute_duty, sync_duty_status
        user      = request.user
        requested = serializer.validated_data.get('duty_status')
        previous  = user.duty_status
        duty      = sync_duty_status(user, compute_duty(user))

        if user.duty_status != previous:     # only audit real transitions
            log_action(
                user        = request.user,
                action      = 'UPDATE',
                module      = 'Accounts',
                description = (
                    f'{user.full_name} duty status synchronized to '
                    f'{user.get_duty_status_display()}'
                ),
                request     = request,
                target_type = 'User',
                target_id   = user.id,
                details     = {
                    'full_name':   user.full_name,
                    'badge_no':    user.badge_number or None,
                    'duty_status': user.get_duty_status_display(),
                    'state':       duty['state'],
                    'updated_at':  timezone.now().isoformat(),
                },
            )
        return Response({
            'message':      f'Duty status is {user.get_duty_status_display()}.',
            'duty_status':  duty['status'],
            'state':        duty['state'],
            'has_schedule': duty['has_schedule'],
            'requested':    requested,
            'overridden':   requested is not None and requested != duty['status'],
            'updated_at':   user.duty_status_updated_at,
        })


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
    
# ─── DAGDAG ITO SA DULO NG accounts/views.py ─────────────────────────────────

class AdminResetPasswordView(APIView):
    """
    POST /api/auth/users/<pk>/reset-password/
    Admin-only — generates a new temp password and emails it to the user.
    """
    permission_classes = [permissions.IsAuthenticated]

    def post(self, request, pk):
        if not request.user.is_admin:
            return Response(
                {'error': 'Permission denied.'},
                status=status.HTTP_403_FORBIDDEN
            )
        try:
            user = CustomUser.objects.get(pk=pk)
        except CustomUser.DoesNotExist:
            return Response({'error': 'User not found.'}, status=status.HTTP_404_NOT_FOUND)

        import secrets
        import string
        alphabet      = string.ascii_letters + string.digits
        temp_password = ''.join(secrets.choice(alphabet) for _ in range(12))
        user.set_password(temp_password)
        user.save()

        send_mail(
            subject    = 'TMEO — Your Password Has Been Reset',
            message    = (
                f'Hello {user.full_name},\n\n'
                f'Your password has been reset by an administrator.\n\n'
                f'Employee ID : {user.id_number}\n'
                f'New Password: {temp_password}\n\n'
                f'Please change your password after logging in.\n\n'
                f'— Administrator'
            ),
            from_email     = settings.DEFAULT_FROM_EMAIL,
            recipient_list = [user.email],
            fail_silently  = True,
        )

        log_action(
            user        = request.user,
            action      = 'UPDATE',
            module      = 'Accounts',
            description = f'Admin reset password for: {user.email}',
            request     = request,
            target_type = 'User',
            target_id   = user.id,
            details     = {
                'target_user': user.full_name,
                'email':       user.email,
                'role':        user.role,
                'reset_by':    request.user.full_name,
                'action':      'Admin password reset — temporary password sent via email',
            },
        )
        return Response({'message': f'Password reset and sent to {user.email}.'})

class PermanentDeleteUserView(APIView):
    """
    DELETE /api/auth/users/<pk>/permanent/
    Admin-only. Permanently removes a user account, but ONLY an account with
    no historical TMEO records (policy HD-B, Role Evolution Phase 4).

    An account that authored or is attributed in audit, violation,
    assessment, payment, evidence, notification, archive, schedule or role
    history records is blocked with 409 - deactivate it instead. The
    history check is server-side (accounts.history_guard) and the database
    PROTECT constraints are the final safety net: a ProtectedError is also
    returned as a controlled 409, never a 500.

    The "Permanently deleted" audit row is written only after the delete has
    succeeded, so a blocked or failed delete cannot leave a false success
    entry. The row's actor is the deleting Admin; the deleted account is only
    mentioned as text, never as a user FK.
    """
    permission_classes = [permissions.IsAuthenticated]

    def _blocked(self, request, pk, full_name, email, role, labels):
        log_action(
            user        = request.user,
            action      = 'DELETE',
            module      = 'User Management',
            description = f'Blocked permanent deletion of account: {full_name} ({role}) - has historical records',
            request     = request,
            status      = 'FAILED',
            target_type = 'User',
            target_id   = pk,
            details     = {
                'target_user': full_name,
                'email':       email,
                'role':        role,
                'reasons':     labels,
                'action':      'Permanent delete blocked - deactivate instead',
            },
        )
        return Response(
            {
                'error':   HISTORY_BLOCK_MESSAGE,
                'code':    'user_has_history',
                'reasons': labels,
            },
            status=status.HTTP_409_CONFLICT,
        )

    def delete(self, request, pk):
        if not request.user.is_admin:
            return Response(
                {'error': 'Permission denied.'},
                status=status.HTTP_403_FORBIDDEN
            )
        # Prevent self-deletion
        if request.user.pk == int(pk):
            return Response(
                {'error': 'You cannot delete your own account.'},
                status=status.HTTP_400_BAD_REQUEST
            )

        with transaction.atomic():
            # Row lock (PostgreSQL): a concurrent request that adds history
            # for this account takes a conflicting lock on the same row, so
            # check + delete cannot interleave with it.
            try:
                user = CustomUser.objects.select_for_update().get(pk=pk)
            except CustomUser.DoesNotExist:
                return Response(
                    {'error': 'User not found.'},
                    status=status.HTTP_404_NOT_FOUND
                )

            full_name = user.full_name
            email     = user.email
            role      = user.role

            refs = get_user_historical_references(user)
            if refs['has_history']:
                return self._blocked(request, pk, full_name, email, role, refs['labels'])

            try:
                # Savepoint so a ProtectedError leaves the outer transaction usable.
                with transaction.atomic():
                    user.delete()
            except ProtectedError:
                # The detector missed a relationship; the database refused.
                return self._blocked(request, pk, full_name, email, role, [])

            # Only now is the deletion real.
            log_action(
                user        = request.user,
                action      = 'DELETE',
                module      = 'User Management',
                description = f'Permanently deleted account: {full_name} ({role}) - {email}',
                request     = request,
                target_type = 'User',
                target_id   = pk,
                details     = {
                    'deleted_user': full_name,
                    'email':        email,
                    'role':         role,
                    'deleted_by':   request.user.full_name,
                    'action':       'Hard delete - account with no historical records permanently removed',
                },
            )

        return Response(
            {'message': f'{full_name} has been permanently deleted.'},
            status=status.HTTP_200_OK
        )


class ChangeUserRoleView(APIView):
    """
    POST /api/auth/users/<pk>/change-role/
    Admin-only. The ONLY endpoint that changes an existing account's role/ID
    (all rules live in accounts.services.change_user_role).

    Payload: {"new_role": "staff" | "enforcer", "reason": "...",
              "expected_role": "<optional, current role the admin saw>"}
    The new ID number is always generated by the server; a client-supplied ID
    is rejected. On success the target's sessions are invalidated: they must
    sign in again with the new ID number.
    """
    permission_classes = [permissions.IsAuthenticated]

    FORBIDDEN_INPUT = ('id_number', 'new_id_number', 'hired_year', 'old_id_number')

    def post(self, request, pk):
        data = request.data
        target = CustomUser.objects.filter(pk=pk).first()
        if target and (
            not target.is_active
            or target.employment_status != CustomUser.EmploymentStatus.ACTIVE
        ):
            return Response(
                {'detail': 'This account is inactive. The only change allowed is reactivation to Active.',
                 'code': 'inactive'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if any(k in data for k in self.FORBIDDEN_INPUT):
            return Response(
                {'error': 'The ID number is assigned by the system and cannot be supplied.',
                 'code': 'id_not_accepted'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        try:
            result = change_user_role(
                target_pk=pk,
                new_role=data.get('new_role'),
                actor=request.user,
                reason=data.get('reason'),
                expected_role=data.get('expected_role'),
                request=request,
            )
        except RoleChangeError as exc:
            if exc.audit:
                log_action(
                    user=request.user, action='UPDATE', module='User Management',
                    description=f'Refused role change for user #{pk}: {exc.code}',
                    request=request, status='FAILED', target_type='User', target_id=pk,
                    details={'new_role': data.get('new_role'), 'code': exc.code},
                )
            return Response({'error': exc.message, 'code': exc.code}, status=exc.http_status)

        user = result.user
        return Response({
            'message': f'{user.full_name} is now {user.get_role_display()}. '
                       f'They must sign in again with their new ID number.',
            'user': {
                'id': user.pk, 'full_name': user.full_name, 'role': user.role,
                'id_number': user.id_number, 'hired_year': user.hired_year,
            },
            'previous': {'role': result.old_role, 'id_number': result.old_id_number},
            'effective_at': result.history.effective_at,
            'sessions_invalidated': True,
        }, status=status.HTTP_200_OK)