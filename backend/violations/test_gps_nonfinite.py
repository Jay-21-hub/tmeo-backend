"""
GPS coordinate hardening - complements the GpsCoordinateRange tests in violations/tests.py.

DRF's FloatField turns the strings 'nan' / 'inf' into real floats. NaN fails every
comparison, so a plain `value < low or value > high` check lets it through.
These tests pin: NaN / +-Infinity rejected, exact limits accepted, None accepted,
omitted coordinates are not re-validated on a partial update.

Run with:  python manage.py test violations.test_gps_nonfinite --settings=core.test_settings_pg
"""
from django.test import SimpleTestCase

from violations.serializers import (
    GpsCoordinateValidationMixin, ViolationDetailSerializer, ViolationEvidenceSerializer,
    _validate_gps_coordinate,
)
from rest_framework import serializers


class HelperRange(SimpleTestCase):

    def test_limits_are_inclusive(self):
        for v in (-90, 90, 0, 0.0, 14.5995):
            self.assertEqual(_validate_gps_coordinate(v, -90, 90, 'Latitude'), v)
        for v in (-180, 180):
            self.assertEqual(_validate_gps_coordinate(v, -180, 180, 'Longitude'), v)

    def test_none_is_allowed(self):
        self.assertIsNone(_validate_gps_coordinate(None, -90, 90, 'Latitude'))

    def test_out_of_range_rejected(self):
        for v in (90.0001, -90.0001, 91, -1000):
            with self.assertRaises(serializers.ValidationError):
                _validate_gps_coordinate(v, -90, 90, 'Latitude')

    def test_nan_and_infinity_rejected_with_the_normal_message(self):
        for v in (float('nan'), float('inf'), float('-inf')):
            with self.subTest(v=v), self.assertRaises(serializers.ValidationError) as ctx:
                _validate_gps_coordinate(v, -90, 90, 'Latitude')
            self.assertIn('Latitude must be between -90 and 90.', str(ctx.exception.detail))


class SerializerLevel(SimpleTestCase):
    """Field-level errors through both real serializers (no database needed)."""

    def _errors(self, serializer_cls, data, partial=False):
        s = serializer_cls(data=data, partial=partial)
        s.is_valid()
        return s.errors

    def test_both_serializers_use_the_shared_mixin(self):
        self.assertTrue(issubclass(ViolationDetailSerializer, GpsCoordinateValidationMixin))
        self.assertTrue(issubclass(ViolationEvidenceSerializer, GpsCoordinateValidationMixin))

    def test_nan_inf_rejected_on_violation_and_evidence(self):
        for cls in (ViolationDetailSerializer, ViolationEvidenceSerializer):
            for field, raw in (('latitude', 'nan'), ('latitude', 'inf'), ('latitude', '-inf'),
                               ('longitude', 'nan'), ('longitude', 'Infinity')):
                with self.subTest(cls=cls.__name__, field=field, raw=raw):
                    errs = self._errors(cls, {field: raw}, partial=True)
                    self.assertIn(field, errs)

    def test_out_of_range_rejected_and_message_is_field_error(self):
        errs = self._errors(ViolationEvidenceSerializer, {'latitude': '90.5', 'longitude': '-181'}, partial=True)
        self.assertEqual(str(errs['latitude'][0]), 'Latitude must be between -90 and 90.')
        self.assertEqual(str(errs['longitude'][0]), 'Longitude must be between -180 and 180.')

    def test_valid_limits_and_null_produce_no_gps_error(self):
        for data in ({'latitude': '90', 'longitude': '180'}, {'latitude': '-90', 'longitude': '-180'},
                     {'latitude': None, 'longitude': None}, {}):
            for cls in (ViolationDetailSerializer, ViolationEvidenceSerializer):
                with self.subTest(cls=cls.__name__, data=data):
                    errs = self._errors(cls, data, partial=True)
                    self.assertNotIn('latitude', errs)
                    self.assertNotIn('longitude', errs)