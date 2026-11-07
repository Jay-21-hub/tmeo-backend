from rest_framework import serializers
from .historical import manila_year
from .models import ArchiveBatch, ArchivedViolation


class ArchiveBatchSerializer(serializers.ModelSerializer):
    created_by_name = serializers.SerializerMethodField()
    # NOT persisted (no migration): only present on the batch object returned
    # by run_archive(), 0 for historical batches read back from the table.
    skipped_already_archived_count = serializers.SerializerMethodField()
    archive_conflict_count = serializers.SerializerMethodField()

    class Meta:
        model = ArchiveBatch
        fields = [
            'id', 'created_by_name', 'created_at', 'status',
            'active_count_before', 'archived_count',
            'skipped_in_progress_count', 'skipped_already_archived_count',
            'archive_conflict_count', 'error_message',
        ]

    def get_skipped_already_archived_count(self, obj):
        return getattr(obj, 'skipped_already_archived_count', 0)

    def get_archive_conflict_count(self, obj):
        return getattr(obj, 'archive_conflict_count', 0)

    def get_created_by_name(self, obj):
        return obj.created_by.full_name if obj.created_by_id else 'Unknown'


ASSESSOR_KEYS = ('assessed_by_name',
                 'assessor_name_snapshot', 'assessor_role_snapshot',
                 'assessor_id_number_snapshot', 'assessor_snapshot_source')


class ArchivedViolationSerializer(serializers.ModelSerializer):
    """
    Archive confidentiality (#12): `data` is exposed via get_data() rather
    than a plain ModelSerializer passthrough. WHO ASSESSED a violation must
    not leak through this API once a record is archived, in ANY form:

      top-level   assessed_by_name
      assessment  assessed_by_name and every assessor_* snapshot key
                  (name / role / id_number / source)

    get_data() returns a copy with those keys removed; the stored snapshot
    is left completely untouched. The PAYMENT CONFIRMER
    (assessment.payment_confirmed_by_name / payment_confirmer_*) is a
    different actor and is still exposed.
    """
    data = serializers.SerializerMethodField()
    # Checkpoint 2: the Asia/Manila year of date_issued. The stored
    # violation_year column (UTC-era in older rows) is left untouched and is
    # no longer what the API reports. Same field name / position / type.
    violation_year = serializers.SerializerMethodField()
    # Evidence preserved at archive time (Checkpoint 1). Read-only.
    evidence = serializers.SerializerMethodField()

    class Meta:
        model = ArchivedViolation
        fields = [
            'id', 'original_violation_id', 'violation_year', 'date_issued',
            'settlement_status', 'settled_at', 'violator_name',
            'license_number', 'plate_number', 'data', 'archived_at', 'batch',
            'evidence',
        ]

    def get_violation_year(self, obj):
        return manila_year(obj.date_issued) if obj.date_issued else obj.violation_year

    def get_evidence(self, obj):
        request = self.context.get('request')
        out = []
        for e in obj.evidence.all():
            url = None
            try:
                url = e.image.url if e.image else None
                if url and request is not None and url.startswith('/'):
                    url = request.build_absolute_uri(url)
            except Exception:   # storage backend unavailable: keep the row, drop the url
                url = None
            out.append({
                'id': e.id,
                'image_url': url,
                'captured_at': e.captured_at.isoformat() if e.captured_at else None,
                'latitude': e.latitude,
                'longitude': e.longitude,
                'gps_accuracy': e.gps_accuracy,
                'captured_by_name': e.captured_by.full_name if e.captured_by_id else '',
            })
        return out

    def get_data(self, obj):
        data = dict(obj.data or {})
        data.pop('assessed_by_name', None)
        assessment = data.get('assessment')
        if isinstance(assessment, dict):
            assessment = {k: v for k, v in assessment.items() if k not in ASSESSOR_KEYS}
            data['assessment'] = assessment
        return data