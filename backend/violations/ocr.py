import base64
import json
import logging
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from io import BytesIO

import numpy as np
from PIL import Image

logger = logging.getLogger(__name__)

OCR_SPACE_URL = 'https://api.ocr.space/parse/image'

# Free tier: 1 MB per image. Stay under it with some margin.
MAX_UPLOAD_BYTES = 900 * 1024
MAX_OCR_DIM = 1280
OCR_TIMEOUT_SECONDS = 60


class OcrServiceError(Exception):
    """Raised when the external OCR service cannot read the image."""


def _autocrop_dark_borders(image):
    """
    Auto-crop dark/black borders around the license card.
    Finds the bounding box of the bright (non-dark) area and crops to it.
    """
    img_array = np.array(image.convert('L'))  # grayscale
    mask = img_array > 40

    rows = np.any(mask, axis=1)
    cols = np.any(mask, axis=0)

    if not rows.any() or not cols.any():
        return image

    row_min, row_max = np.where(rows)[0][[0, -1]]
    col_min, col_max = np.where(cols)[0][[0, -1]]

    pad = 5
    row_min = max(0, row_min - pad)
    row_max = min(img_array.shape[0], row_max + pad)
    col_min = max(0, col_min - pad)
    col_max = min(img_array.shape[1], col_max + pad)

    cropped = image.crop((col_min, row_min, col_max, row_max))

    orig_area = image.size[0] * image.size[1]
    cropped_area = cropped.size[0] * cropped.size[1]
    if cropped_area < orig_area * 0.95:
        return cropped
    return image


def _preprocess_image(image):
    """
    1. Fix EXIF orientation
    2. Downscale to MAX_OCR_DIM
    3. Auto-crop dark borders
    4. Upscale if too small
    5. Enhance contrast/sharpness
    """
    from PIL import ImageOps, ImageEnhance

    try:
        image = ImageOps.exif_transpose(image)
    except Exception:
        pass

    if image.mode != 'RGB':
        image = image.convert('RGB')

    w, h = image.size
    if max(w, h) > MAX_OCR_DIM:
        scale = MAX_OCR_DIM / max(w, h)
        image = image.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.LANCZOS)

    image = _autocrop_dark_borders(image)

    w, h = image.size
    if max(w, h) < 800:
        scale = 800 / max(w, h)
        image = image.resize((int(w * scale), int(h * scale)), Image.LANCZOS)

    image = ImageEnhance.Contrast(image).enhance(1.5)
    image = ImageEnhance.Sharpness(image).enhance(1.8)

    return image


def _encode_under_limit(image):
    """JPEG-encode the image, shrinking quality/size until it fits MAX_UPLOAD_BYTES."""
    current = image
    for _ in range(6):
        for quality in (85, 75, 65, 55):
            buf = BytesIO()
            current.save(buf, format='JPEG', quality=quality)
            data = buf.getvalue()
            if len(data) <= MAX_UPLOAD_BYTES:
                return data
        w, h = current.size
        current = current.resize((max(1, int(w * 0.8)), max(1, int(h * 0.8))), Image.LANCZOS)
    raise OcrServiceError('The photo is too large to read.')


def _call_ocr_space(jpeg_bytes):
    api_key = os.environ.get('OCR_SPACE_API_KEY', '').strip()
    if not api_key:
        raise OcrServiceError('OCR service is not configured (missing API key).')

    payload = urllib.parse.urlencode({
        'apikey': api_key,
        'base64Image': 'data:image/jpeg;base64,' + base64.b64encode(jpeg_bytes).decode('ascii'),
        'language': 'eng',
        'OCREngine': '2',
        'detectOrientation': 'true',
        'scale': 'true',
        'isOverlayRequired': 'false',
    }).encode('utf-8')

    request = urllib.request.Request(OCR_SPACE_URL, data=payload, method='POST')
    try:
        with urllib.request.urlopen(request, timeout=OCR_TIMEOUT_SECONDS) as resp:
            body = resp.read().decode('utf-8', errors='replace')
    except urllib.error.HTTPError as exc:
        logger.error('OCR.space HTTP error: %s', exc.code)
        raise OcrServiceError(f'OCR service returned HTTP {exc.code}.') from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        logger.error('OCR.space unreachable: %s', exc)
        raise OcrServiceError('OCR service could not be reached.') from exc

    try:
        data = json.loads(body)
    except ValueError as exc:
        raise OcrServiceError('OCR service returned an unreadable response.') from exc

    # OCR.space reports failures in the body, not only in the status code.
    if data.get('IsErroredOnProcessing'):
        message = data.get('ErrorMessage')
        if isinstance(message, list):
            message = ' '.join(str(m) for m in message)
        logger.error('OCR.space processing error: %s', message)
        raise OcrServiceError(str(message or 'OCR service could not process the photo.')[:200])

    results = data.get('ParsedResults') or []
    text = '\n'.join((r.get('ParsedText') or '') for r in results)
    return [line.strip() for line in re.split(r'[\r\n]+', text) if line.strip()]


def extract_text_from_base64(base64_string):
    """
    Convert a Base64 image to a list of text lines using the OCR.space API.
    Returns [] when the service worked but found no text.
    Raises OcrServiceError when the service itself failed.
    """
    try:
        if ',' in base64_string:
            base64_string = base64_string.split(',')[1]
        image = Image.open(BytesIO(base64.b64decode(base64_string)))
        image = _preprocess_image(image)
        jpeg_bytes = _encode_under_limit(image)
    except OcrServiceError:
        raise
    except Exception as exc:
        logger.exception('Could not prepare image for OCR')
        raise OcrServiceError('The photo could not be prepared for reading.') from exc

    return _call_ocr_space(jpeg_bytes)


# -- Keywords to skip when searching for name/address ---------------------
_SKIP_KEYWORDS = [
    'REPUBLIC', 'PHILIPPINES', 'DRIVER', 'LICENSE', 'LTO',
    'LAND', 'TRANSPORT', 'DEPARTMENT', 'OFFICE', 'DOTC',
    'SIGNATURE', 'LICENSEE', 'ASSISTANT', 'SECRETARY',
    'NATIONALITY', 'BLOOD', 'TYPE', 'EYES', 'COLOR',
    'CONDITIONS', 'DL CODES', 'AGENCY', 'CODE',
    'LAST NAME', 'FIRST NAME', 'MIDDLE NAME',
    'DATE OF BIRTH', 'EXPIRATION', 'WEIGHT', 'HEIGHT',
    'ADDRESS', 'SEX',
]

_ADDRESS_KEYWORDS = [
    'PUROK', 'BARANGAY', 'BRGY', 'BLVD', 'AVE', 'ST.',
    'STREET', 'ROAD', 'HIGHWAY', 'SUBDIVISION', 'SUBD',
    'BLOCK', 'LOT', 'PHASE', 'ZONE', 'SITIO', 'POBLACION',
    'CENTRO', 'IBABA', 'ILAYA', 'DUPAY',
    # Cities / provinces
    'LUCENA', 'QUEZON', 'MANILA', 'MAKATI', 'PASIG',
    'CALOOCAN', 'TAGUIG', 'PASAY', 'PARANAQUE', 'LAS PINAS',
    'MUNTINLUPA', 'MARIKINA', 'ANTIPOLO', 'CAVITE', 'LAGUNA',
    'BATANGAS', 'RIZAL', 'BULACAN', 'PAMPANGA', 'CEBU',
    'DAVAO', 'ILOILO', 'CAGAYAN', 'ZAMBOANGA',
]


def parse_license_info(text_list):
    """
    Parse PH LTO Driver's License OCR text into structured fields.

    PH LTO DL layout (portrait/vertical card):
      - Name line:      LASTNAME, FIRSTNAME MIDDLENAME  (all caps)
      - Nationality:    PHL
      - Sex:            M or F
      - Date of Birth:  YYYY/MM/DD
      - Address:        multi-word line with city/province
      - License No.:    X##-##-######  (e.g. D07-25-000928)
      - Expiration:     YYYY/MM/DD
      - Blood Type:     A+, B+, O+, AB+, A-, B-, O-, AB-
      - Eyes Color:     BLACK, BROWN, etc.
      - DL Codes:       A,A1,B / B,B1,C / etc.
      - Agency Code:    D07, NCR, etc.
    """
    lines = [t.strip() for t in text_list if t.strip()]
    full_text = ' '.join(lines).upper()

    result = {
        'full_name':      None,
        'violator_name':  None,  # alias
        'license_number': None,
        'address':        None,
        'date_of_birth':  None,
        'expiry_date':    None,
        'blood_type':     None,
        'eyes_color':     None,
        'dl_codes':       None,
        'agency_code':    None,
        'nationality':    None,
        'sex':            None,
    }

    # -- 1. License Number ------------------------------------------------
    lic_patterns = [
        r'\b[A-Z]\d{2}[-\s]?\d{2}[-\s]?\d{6}\b',   # D07-25-000928
        r'\b[A-Z]\d{2}\d{2}\d{6}\b',                 # D072500928 (no dashes)
    ]
    for pat in lic_patterns:
        m = re.search(pat, full_text)
        if m:
            raw = re.sub(r'[\s\-]', '', m.group())
            if len(raw) == 11:
                result['license_number'] = f"{raw[0:3]}-{raw[3:5]}-{raw[5:]}"
            elif len(raw) == 10:
                result['license_number'] = f"{raw[0:2]}-{raw[2:4]}-{raw[4:]}"
            else:
                result['license_number'] = raw
            break

    # -- 2. Dates (YYYY/MM/DD or YYYY-MM-DD) -------------------------------
    date_pattern = r'\b(19|20)\d{2}[\/\-](0[1-9]|1[0-2])[\/\-](0[1-9]|[12]\d|3[01])\b'
    raw_dates = []
    for line in lines:
        m = re.search(date_pattern, line)
        if m:
            raw_dates.append(m.group())

    if len(raw_dates) >= 2:
        result['date_of_birth'] = raw_dates[0]
        result['expiry_date']   = raw_dates[1]
    elif len(raw_dates) == 1:
        yr = int(raw_dates[0][:4])
        if yr < 2000:
            result['date_of_birth'] = raw_dates[0]
        elif yr > 2024:
            result['expiry_date'] = raw_dates[0]
        else:
            result['date_of_birth'] = raw_dates[0]

    if not result['expiry_date']:
        exp_m = re.search(r'EXPIR\w*\s*(?:DATE)?\s*[\:\/]?\s*((20)\d{2}[\/\-]\d{2}[\/\-]\d{2})', full_text)
        if exp_m:
            result['expiry_date'] = exp_m.group(1)

    # -- 3. Blood Type ----------------------------------------------------
    bt_m = re.search(r'\b(A|B|AB|O)[+\-]\b', full_text)
    if bt_m:
        result['blood_type'] = bt_m.group()

    # -- 4. Eyes Color ----------------------------------------------------
    for line in lines:
        ul = line.upper()
        if any(c in ul for c in ['BLACK', 'BROWN', 'BLUE', 'GREEN', 'GRAY', 'HAZEL']):
            if not any(kw in ul for kw in _SKIP_KEYWORDS[:15]):
                result['eyes_color'] = line.strip()
                break

    # -- 5. DL Codes ------------------------------------------------------
    dl_m = re.search(r'\b(A1?|B1?|C|D|BE|CE|DE)(?:[,\s]+(A1?|B1?|C|D|BE|CE|DE))+\b', full_text)
    if dl_m:
        result['dl_codes'] = dl_m.group().replace(' ', '')

    # -- 6. Agency Code ---------------------------------------------------
    agency_m = re.search(r'\b(D\d{2}|NCR|R\d{2}|CAR|CARAGA|BARMM)\b', full_text)
    if agency_m:
        result['agency_code'] = agency_m.group()

    # -- 7. Nationality ---------------------------------------------------
    if 'PHL' in full_text or 'FILIPINO' in full_text:
        result['nationality'] = 'PHL'

    # -- 8. Sex -----------------------------------------------------------
    sex_m = re.search(r'\bSEX\s*[:\-]?\s*(M|F|MALE|FEMALE)\b', full_text)
    if sex_m:
        raw_sex = sex_m.group(1)
        result['sex'] = 'M' if raw_sex.startswith('M') else 'F'
    else:
        for line in lines:
            if line.strip() in ('M', 'F'):
                result['sex'] = line.strip()
                break

    # -- 9. Name ----------------------------------------------------------
    name_candidates = []
    for line in lines:
        clean = re.sub(r'[^A-Za-z\s,.\-]', '', line).strip()
        if len(clean) < 8:
            continue
        ul = clean.upper()
        if ',' not in clean:
            continue
        if any(kw in ul for kw in _SKIP_KEYWORDS):
            continue
        alpha_only = re.sub(r'[\s,.]', '', clean)
        if not alpha_only:
            continue
        upper_ratio = sum(1 for c in alpha_only if c.isupper()) / len(alpha_only)
        if upper_ratio < 0.7:
            continue
        parts = clean.split(',')
        if len(parts) >= 2 and len(parts[0].strip()) >= 2:
            name_candidates.append(clean.strip())

    if name_candidates:
        result['full_name'] = max(name_candidates, key=len)

    if not result['full_name']:
        for line in lines:
            clean = re.sub(r'[^A-Za-z\s]', '', line).strip()
            if len(clean) < 8:
                continue
            ul = clean.upper()
            if any(kw in ul for kw in _SKIP_KEYWORDS):
                continue
            words = clean.split()
            if len(words) >= 2 and all(w.isupper() for w in words):
                result['full_name'] = clean
                break

    result['violator_name'] = result['full_name']

    # -- 10. Address ------------------------------------------------------
    addr_lines = []
    for line in lines:
        ul = line.upper()
        if any(kw in ul for kw in _ADDRESS_KEYWORDS):
            if result['full_name'] and result['full_name'].upper() in ul:
                continue
            if any(skip in ul for skip in _SKIP_KEYWORDS[:10]):
                continue
            addr_lines.append(line.strip())

    if addr_lines:
        result['address'] = ', '.join(dict.fromkeys(addr_lines))

    if not result['address']:
        postal_m = re.search(r'.{10,}\b\d{4}\b', full_text)
        if postal_m:
            result['address'] = postal_m.group().strip()

    return {k: v for k, v in result.items() if v is not None}