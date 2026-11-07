import base64
import re
from io import BytesIO
from PIL import Image

_reader = None


def _get_reader():
    global _reader
    if _reader is None:
        import easyocr
        _reader = easyocr.Reader(['en'], gpu=False)
    return _reader


def _autocrop_dark_borders(image):
    """
    Auto-crop dark/black borders around the license card.
    Finds the bounding box of the bright (non-dark) area and crops to it.
    This handles cameras that produce black bars on the sides.
    """
    import numpy as np

    img_array = np.array(image.convert('L'))  # grayscale

    # Threshold: pixels brighter than 40 are considered "content"
    mask = img_array > 40

    # Find rows and columns that have content
    rows = np.any(mask, axis=1)
    cols = np.any(mask, axis=0)

    if not rows.any() or not cols.any():
        return image  # can't crop — return original

    row_min, row_max = np.where(rows)[0][[0, -1]]
    col_min, col_max = np.where(cols)[0][[0, -1]]

    # Add small padding (5px) so we don't cut off edge text
    pad = 5
    row_min = max(0, row_min - pad)
    row_max = min(img_array.shape[0], row_max + pad)
    col_min = max(0, col_min - pad)
    col_max = min(img_array.shape[1], col_max + pad)

    cropped = image.crop((col_min, row_min, col_max, row_max))

    # Only use crop if it's meaningfully smaller (avoid cropping valid content)
    orig_area    = image.size[0] * image.size[1]
    cropped_area = cropped.size[0] * cropped.size[1]
    if cropped_area < orig_area * 0.95:
        return cropped
    return image


def _preprocess_image(image):
    """
    Preprocess image for best OCR results:
    1. Fix EXIF orientation
    2. Auto-crop dark borders (handles black bars from camera)
    3. Upscale if too small
    4. Enhance contrast/sharpness
    """
    from PIL import ImageOps, ImageEnhance

    # Fix EXIF orientation first
    try:
        image = ImageOps.exif_transpose(image)
    except Exception:
        pass

    # Convert to RGB if needed
    if image.mode != 'RGB':
        image = image.convert('RGB')

    # Auto-crop dark borders — removes black bars from camera capture
    image = _autocrop_dark_borders(image)

    # Upscale if too small (OCR struggles below ~800px wide)
    w, h = image.size
    if max(w, h) < 800:
        scale = 800 / max(w, h)
        image = image.resize((int(w * scale), int(h * scale)), Image.LANCZOS)

    # Resize if too large (speeds up OCR significantly)
    max_dim = 2000
    w, h = image.size
    if max(w, h) > max_dim:
        scale = max_dim / max(w, h)
        image = image.resize((int(w * scale), int(h * scale)), Image.LANCZOS)

    # Enhance contrast and sharpness
    image = ImageEnhance.Contrast(image).enhance(1.5)
    image = ImageEnhance.Sharpness(image).enhance(1.8)

    return image


def _count_valid_words(text_list):
    """Count how many OCR results look like real words (not garbage)."""
    valid = 0
    for t in text_list:
        clean = t.strip()
        # Real word: mostly letters, length > 2, not all symbols
        alpha = sum(1 for c in clean if c.isalpha())
        if alpha >= 2 and alpha / max(len(clean), 1) > 0.5:
            valid += 1
    return valid


def extract_text_from_base64(base64_string):
    """
    Convert Base64 image to text list using EasyOCR.
    Tries all 4 rotations and picks the one with the most readable text.
    This handles licenses photographed sideways or upside down.
    """
    try:
        if ',' in base64_string:
            base64_string = base64_string.split(',')[1]
        image_bytes = base64.b64decode(base64_string)
        image = Image.open(BytesIO(image_bytes))
        image = _preprocess_image(image)

        reader = _get_reader()

        best_results = []
        best_score   = -1
        best_rotation = 0

        # Try 0°, 90°, 180°, 270°
        for angle in [0, 90, 270, 180]:
            if angle == 0:
                rotated = image
            else:
                rotated = image.rotate(angle, expand=True)

            try:
                results = reader.readtext(rotated, detail=0)
            except Exception:
                results = []

            score = _count_valid_words(results)

            # Bonus: if we find PH LTO keywords, heavily favor this rotation
            combined = ' '.join(results).upper()
            if any(kw in combined for kw in [
                'REPUBLIC', 'PHILIPPINES', 'DRIVER', 'LICENSE',
                'SALAZAR', 'LUCENA', 'QUEZON', 'PUROK',
            ]):
                score += 20

            if score > best_score:
                best_score    = score
                best_results  = results
                best_rotation = angle

        return best_results

    except Exception:
        return []


# ── Keywords to skip when searching for name/address ──────────────────────────
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

    # ── 1. License Number ─────────────────────────────────────────────────────
    # Format: D07-25-000928  or  N01-23-456789  or  A05-19-123456
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

    # ── 2. Dates (YYYY/MM/DD or YYYY-MM-DD) ──────────────────────────────────
    date_pattern = r'\b(19|20)\d{2}[\/\-](0[1-9]|1[0-2])[\/\-](0[1-9]|[12]\d|3[01])\b'
    dates_found = re.findall(date_pattern, full_text)
    # Also scan raw lines for date strings
    raw_dates = []
    for line in lines:
        m = re.search(date_pattern, line)
        if m:
            raw_dates.append(m.group())

    if len(raw_dates) >= 2:
        # First date = date of birth, second = expiration (by position on card)
        result['date_of_birth'] = raw_dates[0]
        result['expiry_date']   = raw_dates[1]
    elif len(raw_dates) == 1:
        # Try to figure out which one based on year
        yr = int(raw_dates[0][:4])
        if yr < 2000:
            result['date_of_birth'] = raw_dates[0]
        elif yr > 2024:
            result['expiry_date'] = raw_dates[0]
        else:
            result['date_of_birth'] = raw_dates[0]

    # Expiration may also appear as standalone year near "EXPIRATION" keyword
    if not result['expiry_date']:
        exp_m = re.search(r'EXPIR\w*\s*(?:DATE)?\s*[\:\/]?\s*((20)\d{2}[\/\-]\d{2}[\/\-]\d{2})', full_text)
        if exp_m:
            result['expiry_date'] = exp_m.group(1)

    # ── 3. Blood Type ─────────────────────────────────────────────────────────
    bt_m = re.search(r'\b(A|B|AB|O)[+\-]\b', full_text)
    if bt_m:
        result['blood_type'] = bt_m.group()

    # ── 4. Eyes Color ─────────────────────────────────────────────────────────
    for line in lines:
        ul = line.upper()
        if any(c in ul for c in ['BLACK', 'BROWN', 'BLUE', 'GREEN', 'GRAY', 'HAZEL']):
            # Make sure it's not part of address or name
            if not any(kw in ul for kw in _SKIP_KEYWORDS[:15]):
                result['eyes_color'] = line.strip()
                break

    # ── 5. DL Codes ───────────────────────────────────────────────────────────
    # Format: A,A1,B  or  B,B1,C  or  A1,B
    dl_m = re.search(r'\b(A1?|B1?|C|D|BE|CE|DE)(?:[,\s]+(A1?|B1?|C|D|BE|CE|DE))+\b', full_text)
    if dl_m:
        result['dl_codes'] = dl_m.group().replace(' ', '')

    # ── 6. Agency Code ────────────────────────────────────────────────────────
    # Format: D07, NCR, R04, etc.
    agency_m = re.search(r'\b(D\d{2}|NCR|R\d{2}|CAR|CARAGA|BARMM)\b', full_text)
    if agency_m:
        result['agency_code'] = agency_m.group()

    # ── 7. Nationality ────────────────────────────────────────────────────────
    if 'PHL' in full_text or 'FILIPINO' in full_text:
        result['nationality'] = 'PHL'

    # ── 8. Sex ────────────────────────────────────────────────────────────────
    sex_m = re.search(r'\bSEX\s*[:\-]?\s*(M|F|MALE|FEMALE)\b', full_text)
    if sex_m:
        raw_sex = sex_m.group(1)
        result['sex'] = 'M' if raw_sex.startswith('M') else 'F'
    else:
        # Standalone M or F line near nationality
        for i, line in enumerate(lines):
            if line.strip() in ('M', 'F'):
                result['sex'] = line.strip()
                break

    # ── 9. Name ───────────────────────────────────────────────────────────────
    # PH LTO format: LASTNAME, FIRSTNAME MIDDLENAME (all caps, one long line)
    name_candidates = []
    for line in lines:
        clean = re.sub(r'[^A-Za-z\s,.\-]', '', line).strip()
        if len(clean) < 8:
            continue
        ul = clean.upper()
        # Must have a comma (LAST, FIRST format)
        if ',' not in clean:
            continue
        # Skip header/label lines
        if any(kw in ul for kw in _SKIP_KEYWORDS):
            continue
        # Must be mostly uppercase letters
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
        # Pick longest candidate (most complete name)
        result['full_name'] = max(name_candidates, key=len)

    # Fallback: look for all-caps multi-word line without comma
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

    # ── 10. Address ───────────────────────────────────────────────────────────
    # Strategy: find line(s) containing address keywords, then merge if split
    addr_lines = []
    for line in lines:
        ul = line.upper()
        if any(kw in ul for kw in _ADDRESS_KEYWORDS):
            # Skip if it's a name line
            if result['full_name'] and result['full_name'].upper() in ul:
                continue
            if any(skip in ul for skip in _SKIP_KEYWORDS[:10]):
                continue
            addr_lines.append(line.strip())

    if addr_lines:
        # Merge consecutive address lines (address often spans 2 lines on card)
        result['address'] = ', '.join(dict.fromkeys(addr_lines))  # dedupe

    # Fallback: longest line with postal code pattern
    if not result['address']:
        postal_m = re.search(r'.{10,}\b\d{4}\b', full_text)
        if postal_m:
            result['address'] = postal_m.group().strip()

    # ── Clean up None values ──────────────────────────────────────────────────
    return {k: v for k, v in result.items() if v is not None}