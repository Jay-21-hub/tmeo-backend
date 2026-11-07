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
    except Exception as exc:
        import logging
        logging.getLogger(__name__).warning('FCM notification failed: %s', exc) # Never block main flow for notification failures


# Deployment 

def send_deployment_notification(enforcer, area, deployed_by):
    now = timezone.now().strftime("%B %d, %Y %I:%M %p")

    # Email → enforcer
    send_mail(
        subject       = 'Traffic Enforcement and Violation Management System — Deployment Notice',
        message       = f'''Good day, {enforcer.full_name}!

You have been deployed to the following area:

📍 Area       : {area}
👮 Deployed by: {deployed_by.full_name}
🕐 Time       : {now}

Please report to your designated area immediately.

— Traffic Enforcement and Violation Management System, Lucena City''',
        from_email    = settings.DEFAULT_FROM_EMAIL,
        recipient_list= [enforcer.email],
        fail_silently = False,
    )

    # Email → all admins
    admins       = CustomUser.objects.filter(role='admin', is_active=True)
    admin_emails = list(admins.values_list('email', flat=True))
    if admin_emails:
        send_mail(
            subject       = f'Traffic Enforcement and Violation Management System — Enforcer Deployed: {enforcer.full_name}',
            message       = f'''Deployment Alert

Enforcer   : {enforcer.full_name}
Badge No.  : {enforcer.badge_number}
Area       : {area}
Deployed by: {deployed_by.full_name}
Time       : {now}

— Traffic Enforcement and Violation Management System, Lucena City''',
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


# Geofence 

def send_geofence_alert(enforcer, current_lat, current_lon,
                        center_lat, center_lon, distance_meters,
                        radius_meters=None, scheduled_area=None):
    """
    Admin alert (email + FCM) for an on-duty enforcer whose reported position
    is farther than the configured radius from the Lucena City centre.

    What is actually checked: distance from the Lucena City centre. It is NOT
    a test against the scheduled/assigned area's boundary, so the message never
    says the enforcer left an "assigned" or "designated" area.
    `scheduled_area` (today's EnforcerSchedule.assigned_area) is shown only as
    informational context and is clearly labelled as not checked.
    """
    now          = timezone.localtime().strftime("%B %d, %Y %I:%M %p")
    admins       = CustomUser.objects.filter(role='admin', is_active=True)
    admin_emails = list(admins.values_list('email', flat=True))

    radius_txt = f'{radius_meters:.0f} m' if radius_meters else 'the configured radius'
    area_line  = (
        f'\nScheduled Area (informational only, boundary not checked): {scheduled_area}'
        if scheduled_area else ''
    )

    # Email → all admins
    if admin_emails:
        send_mail(
            subject       = f'Traffic Enforcement and Violation Management System  — Geofence Alert: {enforcer.full_name}',
            message       = f'''⚠️ GEOFENCE ALERT

Enforcer  : {enforcer.full_name}
Badge No. : {enforcer.badge_number or "N/A"}
ID Number : {enforcer.id_number}
Time      : {now}

The enforcer's reported location is outside the configured Lucena City center geofence ({radius_txt} radius).

Current Location            : {current_lat:.6f}, {current_lon:.6f}
Distance from Lucena center : {distance_meters:.0f} meters{area_line}

Please verify the enforcer's location.

— Traffic Enforcement and Violation Management System, Lucena City''',
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
                f'{enforcer.full_name} is {distance_meters:.0f}m from Lucena City '
                f'center, outside the {radius_txt} geofence.'
            ),
            data  = {
                'type':             'geofence',
                'enforcer_id':      str(enforcer.id),
                'distance_meters':  str(round(distance_meters)),
                'current_lat':      str(current_lat),
                'current_lon':      str(current_lon),
            },
        )


# Violation Issued

def send_violation_notification(violation):
    """
    FCM push to enforcer when their violation is marked as paid.
    Call this from ViolationViewSet mark_paid action.
    """
    enforcer = violation.enforcer
    if not enforcer:
        return

    if violation.status == 'paid':
        title = 'Violation Paid 💰'
        body  = f'Violation #{violation.id} has been marked as paid.'
    else:
        return

    send_fcm_notification(
        token = getattr(enforcer, 'fcm_token', None),
        title = title,
        body  = body,
        data  = {
            'type':         'violation_update',
            'violation_id': str(violation.id),
            'status':       violation.status,
        },
    )