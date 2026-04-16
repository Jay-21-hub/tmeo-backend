import easyocr
import base64
import re
from io import BytesIO
from PIL import Image


# Initialize reader once (English) — mabagal mag-load first time
reader = easyocr.Reader(['en'], gpu=False)


def extract_text_from_base64(base64_string):
    """Convert Base64 image to text using EasyOCR."""
    try:
        # Remove header (data:image/jpeg;base64,)
        if ',' in base64_string:
            base64_string = base64_string.split(',')[1]

        # Decode Base64 to bytes
        image_bytes = base64.b64decode(base64_string)
        image = Image.open(BytesIO(image_bytes))

        # Run OCR
        results = reader.readtext(image, detail=0)
        return results  # List of detected text strings

    except Exception as e:
        return []


def parse_license_info(text_list):
    """
    Parse extracted text into structured license info.
    Returns: name, license_number, address
    """
    full_text = ' '.join(text_list).upper()
    lines     = [t.strip() for t in text_list if t.strip()]

    license_number = None
    name           = None
    address        = None

    for line in lines:
        # License number pattern: N01-23-456789
        if re.match(r'^[A-Z]\d{2}-\d{2}-\d{6}$', line):
            license_number = line

        # Address keywords
        if any(kw in line.upper() for kw in ['ST.', 'AVE', 'BLVD', 'ROAD', 'BRGY', 'BARANGAY', 'CITY', 'QUEZON', 'MANILA']):
            address = line

    # Name — usually the longest ALL CAPS line without numbers
    name_candidates = [
        l for l in lines
        if l.isupper() and len(l) > 5 and not any(c.isdigit() for c in l)
        and not any(kw in l for kw in ['REPUBLIC', 'PHILIPPINES', 'DRIVER', 'LICENSE', 'LTO'])
    ]
    if name_candidates:
        name = max(name_candidates, key=len)

    return {
        'violator_name':   name,
        'license_number':  license_number,
        'address':         address,
    }