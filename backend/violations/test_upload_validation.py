"""
Stage B hardening - 10 MB image limit on evidence photos and OVR license photos.

Run with:  python manage.py test violations.test_upload_validation --settings=core.test_settings
"""
import json
import os
from io import BytesIO
from unittest import mock

from django.core.files.uploadedfile import SimpleUploadedFile
from django.utils import timezone
from PIL import Image

from violations.models import ViolationEvidence
from violations.tests import BaseRoleTestCase
from violations.upload_validation import MAX_IMAGE_UPLOAD_BYTES

EVIDENCE_URL = '/api/violations/evidence/'


def jpeg_bytes(size=(64, 48), color=(200, 30, 30)):
    buf = BytesIO()
    Image.new('RGB', size, color).save(buf, 'JPEG')
    return buf.getvalue()


def noisy_png_bytes(side=2400):
    """Incompressible RGB noise -> PNG > 10 MB."""
    img = Image.frombytes('RGB', (side, side), os.urandom(side * side * 3))
    buf = BytesIO()
    img.save(buf, 'PNG', compress_level=1)
    return buf.getvalue()


class EvidenceImageSize(BaseRoleTestCase):

    def _post(self, content, name='shot.jpg', ctype='image/jpeg'):
        return self.as_user(self.enforcer_a).post(
            EVIDENCE_URL,
            {'image': SimpleUploadedFile(name, content, content_type=ctype),
             'captured_at': timezone.now().isoformat()},
            format='multipart',
        )

    def test_normal_photo_is_accepted(self):
        res = self._post(jpeg_bytes())
        self.assertEqual(res.status_code, 201, res.data)
        self.assertEqual(ViolationEvidence.objects.count(), 1)

    def test_realistic_4k_camera_frame_is_well_under_the_limit(self):
        # What EvidenceCapture.jsx produces: a video frame re-encoded as JPEG q0.92.
        buf = BytesIO()
        Image.effect_noise((3840, 2160), 40).convert('RGB').save(buf, 'JPEG', quality=92)
        self.assertLess(len(buf.getvalue()), MAX_IMAGE_UPLOAD_BYTES)
        self.assertEqual(self._post(buf.getvalue()).status_code, 201)

    def test_image_over_limit_is_rejected_with_400(self):
        data = noisy_png_bytes()
        self.assertGreater(len(data), MAX_IMAGE_UPLOAD_BYTES)
        res = self._post(data, name='big.png', ctype='image/png')
        self.assertEqual(res.status_code, 400)
        self.assertIn('image', res.data)
        self.assertIn('10 MB', str(res.data['image'][0]))
        self.assertEqual(ViolationEvidence.objects.count(), 0)

    def test_limit_boundary_is_inclusive(self):
        data = jpeg_bytes()
        with mock.patch('violations.upload_validation.MAX_IMAGE_UPLOAD_BYTES', len(data)):
            self.assertEqual(self._post(data).status_code, 201)
        with mock.patch('violations.upload_validation.MAX_IMAGE_UPLOAD_BYTES', len(data) - 1):
            self.assertEqual(self._post(data).status_code, 400)

    def test_non_image_still_rejected_by_existing_validation(self):
        self.assertEqual(self._post(b'not an image', name='x.jpg').status_code, 400)


class OvrLicensePhotoSize(BaseRoleTestCase):

    def _payload(self, image):
        return {
            'violator_name': 'DELA CRUZ, JUAN',
            'ovr_number': 'OVR-IMG-001',
            'location': 'ML Tagarao Street',
            'date_issued': timezone.now().isoformat(),
            # the real frontend sends the id list JSON-encoded inside the multipart body
            'violation_type_ids': json.dumps([self.vtype.id]),
            'status': 'pending',
            'source': 'enforcer_ovr',
            'image': image,
        }

    def test_ovr_with_normal_photo_is_created(self):
        res = self.as_user(self.enforcer_a).post(
            '/api/violations/create/',
            self._payload(SimpleUploadedFile('lic.jpg', jpeg_bytes(), content_type='image/jpeg')),
            format='multipart',
        )
        self.assertEqual(res.status_code, 201, res.data)

    def test_ovr_with_3mb_photo_is_created_not_500(self):
        # Regression: a photo above FILE_UPLOAD_MAX_MEMORY_SIZE (2.5 MB) is spooled to disk and
        # used to crash `request.data.copy()` (deepcopy of a BufferedRandom) -> HTTP 500.
        # The UI allows license photos up to 5 MB, so this is a normal real-world size.
        buf = BytesIO()
        Image.effect_noise((2200, 1700), 80).convert('RGB').save(buf, 'JPEG', quality=95)
        self.assertGreater(len(buf.getvalue()), 3 * 1024 * 1024)
        res = self.as_user(self.enforcer_a).post(
            '/api/violations/create/',
            self._payload(SimpleUploadedFile('lic.jpg', buf.getvalue(), content_type='image/jpeg')),
            format='multipart',
        )
        self.assertEqual(res.status_code, 201, res.data)

    def test_ovr_with_oversized_photo_is_rejected(self):
        res = self.as_user(self.enforcer_a).post(
            '/api/violations/create/',
            self._payload(SimpleUploadedFile('big.png', noisy_png_bytes(), content_type='image/png')),
            format='multipart',
        )
        self.assertEqual(res.status_code, 400)
        self.assertIn('image', res.data)