from django.core.mail import send_mail
from django.conf import settings
from accounts.models import CustomUser


def send_deployment_notification(enforcer, area, deployed_by):
    # Email sa enforcer mismo
    send_mail(
        subject = 'TMEO — Deployment Notice',
        message = f'''Good day, {enforcer.full_name}!

You have been deployed to the following area:

📍 Area     : {area}
👮 Deployed by: {deployed_by.full_name}
🕐 Time     : {__import__("django.utils.timezone", fromlist=["timezone"]).timezone.now().strftime("%B %d, %Y %I:%M %p")}

Please report to your designated area immediately.

— TMEO System''',
        from_email    = settings.DEFAULT_FROM_EMAIL,
        recipient_list= [enforcer.email],
        fail_silently = False,
    )

    # Email sa lahat ng Admin
    admins = CustomUser.objects.filter(role='admin', is_active=True)
    admin_emails = list(admins.values_list('email', flat=True))

    if admin_emails:
        send_mail(
            subject = f'TMEO — Enforcer Deployed: {enforcer.full_name}',
            message = f'''Deployment Alert

Enforcer : {enforcer.full_name}
Badge No.: {enforcer.badge_number}
Area     : {area}
Deployed by: {deployed_by.full_name}
Time     : {__import__("django.utils.timezone", fromlist=["timezone"]).timezone.now().strftime("%B %d, %Y %I:%M %p")}

— TMEO System''',
            from_email    = settings.DEFAULT_FROM_EMAIL,
            recipient_list= admin_emails,
            fail_silently = False,
        )