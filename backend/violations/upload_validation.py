"""
Upload limits for photos sent to the API.

10 MB matches Cloudinary's per-image limit on the free plan and is far above what the
app itself produces (camera frames are re-encoded to JPEG q0.92 in the browser; license
photos are capped at 5 MB client-side). It exists to stop an oversized body from being
buffered/forwarded to Cloudinary and failing late with a confusing 500.
"""
from rest_framework import serializers

MAX_IMAGE_UPLOAD_BYTES = 10 * 1024 * 1024  # 10 MB


def validate_image_size(file):
    """Serializer-field validator. `file` is the uploaded file (None/empty is left to the field)."""
    size = getattr(file, 'size', None)
    if size is not None and size > MAX_IMAGE_UPLOAD_BYTES:
        raise serializers.ValidationError(
            f'Image is too large ({size / (1024 * 1024):.1f} MB). The maximum allowed size is '
            f'{MAX_IMAGE_UPLOAD_BYTES // (1024 * 1024)} MB.'
        )
    return file