import math
from django.core.mail import send_mail
from django.conf import settings
from django.utils import timezone
from accounts.models import CustomUser


# ─── Helpers ────────────────────────────────────────────────────────────────

def calculate_distance_meters(lat1, lon1, lat2, lon2):
    R       = 6371000
    phi1    = math.radians(lat1)
    phi2    = math.radians(lat2)
    dphi    = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = (math.sin(dphi / 2) ** 2
         + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2)
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def send_fcm_notification(token, title, body, data=None):
    """
    Send FCM push notification to a single device token.
    Silently fails if firebase is not configured or token is missing.
    """
    if not token:
        return

    try:
        from firebase_admin import messaging
        from firebase import get_firebase_app
        get_firebase_app()

        message = messaging.Message(
            notification=messaging.Notification(title=title, body=body),
            data=data or {},
            token=token,
        )
        messaging.send(message)
    except Exception:
        pass  # Never block main flow for notification failures


# ─── Deployment ─────────────────────────────────────────────────────────────

def send_deployment_notification(enforcer, area, deployed_by):
    now = timezone.now().strftime("%B %d, %Y %I:%M %p")

    # Email → enforcer
    send_mail(
        subject       = 'TMEO — Deployment Notice',
        message       = f'''Good day, {enforcer.full_name}!

You have been deployed to the following area:

📍 Area       : {area}
👮 Deployed by: {deployed_by.full_name}
🕐 Time       : {now}

Please report to your designated area immediately.

— TMEO System''',
        from_email    = settings.DEFAULT_FROM_EMAIL,
        recipient_list= [enforcer.email],
        fail_silently = False,
    )

    # Email → all admins
    admins       = CustomUser.objects.filter(role='admin', is_active=True)
    admin_emails = list(admins.values_list('email', flat=True))
    if admin_emails:
        send_mail(
            subject       = f'TMEO — Enforcer Deployed: {enforcer.full_name}',
            message       = f'''Deployment Alert

Enforcer   : {enforcer.full_name}
Badge No.  : {enforcer.badge_number}
Area       : {area}
Deployed by: {deployed_by.full_name}
Time       : {now}

— TMEO System''',
            from_email    = settings.DEFAULT_FROM_EMAIL,
            recipient_list= admin_emails,
            fail_silently = False,
        )

    # FCM → enforcer mobile
    send_fcm_notification(
        token = getattr(enforcer, 'fcm_token', None),
        title = 'New Deployment Order',
        body  = f'You have been deployed to {area}.',
        data  = {'type': 'deployment', 'area': area},
    )


# ─── Geofence ───────────────────────────────────────────────────────────────

def send_geofence_alert(enforcer, current_lat, current_lon,
                        assigned_lat, assigned_lon, distance_meters):
    now          = timezone.now().strftime("%B %d, %Y %I:%M %p")
    admins       = CustomUser.objects.filter(role='admin', is_active=True)
    admin_emails = list(admins.values_list('email', flat=True))

    # Email → all admins
    if admin_emails:
        send_mail(
            subject       = f'TMEO — Geofence Alert: {enforcer.full_name}',
            message       = f'''⚠️ GEOFENCE ALERT

Enforcer  : {enforcer.full_name}
Badge No. : {enforcer.badge_number or "N/A"}
ID Number : {enforcer.id_number}
Time      : {now}

The enforcer has moved outside their designated area.

Current Location  : {current_lat:.6f}, {current_lon:.6f}
Assigned Area     : {enforcer.assigned_area or "Not set"}
Distance from Area: {distance_meters:.0f} meters

Please verify the enforcer's location immediately.

— TMEO System''',
            from_email    = settings.DEFAULT_FROM_EMAIL,
            recipient_list= admin_emails,
            fail_silently = True,
        )

    # FCM → all admins (mobile alert)
    for admin in admins:
        send_fcm_notification(
            token = getattr(admin, 'fcm_token', None),
            title = '⚠️ Geofence Alert',
            body  = (
                f'{enforcer.full_name} is {distance_meters:.0f}m '
                f'outside their assigned area.'
            ),
            data  = {
                'type':             'geofence',
                'enforcer_id':      str(enforcer.id),
                'distance_meters':  str(round(distance_meters)),
                'current_lat':      str(current_lat),
                'current_lon':      str(current_lon),
            },
        )


# ─── Violation Issued ────────────────────────────────────────────────────────

def send_violation_notification(violation):
    """
    FCM push to enforcer when their violation is approved or paid.
    Call this from ViolationViewSet approve/mark_paid actions.
    """
    enforcer = violation.enforcer
    if not enforcer:
        return

    if violation.status == 'approved':
        title = 'Violation Approved ✅'
        body  = f'Violation {violation.violation_id} has been approved.'
    elif violation.status == 'paid':
        title = 'Violation Paid 💰'
        body  = f'Violation {violation.violation_id} has been marked as paid.'
    else:
        return

    send_fcm_notification(
        token = getattr(enforcer, 'fcm_token', None),
        title = title,
        body  = body,
        data  = {
            'type':         'violation_update',
            'violation_id': violation.violation_id,
            'status':       violation.status,
        },
    )