import firebase_admin
from firebase_admin import credentials, db

_app = None

def get_firebase_app():
    global _app
    if _app is None:
        cred = credentials.Certificate('firebase-credentials.json')
        _app = firebase_admin.initialize_app(cred, {
            'databaseURL': 'https://tmeo-backend-default-rtdb.firebaseio.com'
        })
    return _app


def push_violation_to_firebase(violation):
    get_firebase_app()
    ref = db.reference(f'violations/{violation.violation_id}')
    ref.set({
        'violation_id':   violation.violation_id,
        'violator_name':  violation.violator_name,
        'plate_number':   violation.plate_number,
        'violation_type': violation.violation_type.name,
        'status':         violation.status,
        'penalty_amount': str(violation.penalty_amount),
        'date_time':      violation.date_time.strftime('%Y-%m-%d %H:%M:%S'),
        'location':       violation.location,
    })