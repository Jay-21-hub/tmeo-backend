import logging
import firebase_admin
from django.conf import settings
from firebase_admin import credentials, db

logger = logging.getLogger(__name__)

_app = None
_firebase_available = None


def get_firebase_app():
    global _app, _firebase_available

    if _firebase_available is False:
        return None
    if _app is not None:
        return _app

    cred_path = getattr(settings, 'FIREBASE_CREDENTIALS_PATH', 'firebase-credentials.json')
    db_url    = getattr(settings, 'FIREBASE_DATABASE_URL',
                        'https://tmeo-backend-default-rtdb.firebaseio.com')
    try:
        cred = credentials.Certificate(cred_path)
        _app = firebase_admin.initialize_app(cred, {'databaseURL': db_url})
        _firebase_available = True
        logger.info('Firebase initialised successfully.')
        return _app
    except FileNotFoundError:
        _firebase_available = False
        logger.warning(
            'firebase-credentials.json hindi mahanap sa "%s". '
            'Push notifications disabled.',
            cred_path,
        )
        return None
    except Exception as exc:
        _firebase_available = False
        logger.error('Firebase error: %s', exc)
        return None


def push_violation_to_firebase(violation) -> bool:
    app = get_firebase_app()
    if app is None:
        return False

    try:
        type_names = ', '.join(
            item.violation_type.name
            for item in violation.items.select_related('violation_type').all()
            if item.violation_type
        ) or '—'

        ref = db.reference(f'violations/{violation.id}')
        ref.set({
            'violation_id':   violation.id,
            'violator_name':  violation.violator_name,
            'plate_number':   violation.plate_number,
            'violation_type': type_names,
            'status':         violation.status,
            'penalty_amount': str(violation.penalty_amount),
            'date_time':      violation.date_issued.strftime('%Y-%m-%d %H:%M:%S') if violation.date_issued else '',
            'location':       violation.location,
        })
        return True
    except Exception as exc:
        logger.error('Firebase push failed: %s', exc)
        return False