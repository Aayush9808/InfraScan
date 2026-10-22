"""Shared road-hazard severity policy.

The severity of a detection is derived from the fraction of the frame that its
bounding box covers. Keeping the thresholds in one module guarantees that the
CLI pipeline and the web dashboard classify hazards identically.

Colours are OpenCV BGR tuples so they can be used directly when annotating.
"""

from __future__ import annotations

CRITICAL = "CRITICAL"
MODERATE = "MODERATE"
MINOR = "MINOR"

# Lower bound (inclusive) of each severity band, expressed as a percentage of
# the frame area. Ordered from most to least severe.
SEVERITY_BANDS = (
    (CRITICAL, 8.0, (0, 0, 255)),
    (MODERATE, 2.5, (0, 140, 255)),
    (MINOR, 0.0, (0, 215, 255)),
)


def classify_severity(box_area: float, frame_area: float):
    """Return ``(severity, colour, coverage_pct)`` for a bounding box.

    ``box_area`` and ``frame_area`` are expressed in pixels. A zero or invalid
    frame area is treated as a minor, zero-coverage detection instead of
    raising, matching the defensive behaviour of the original pipeline.
    """

    if frame_area <= 0:
        return MINOR, (0, 215, 255), 0.0

    ratio = float(box_area) / float(frame_area) * 100.0
    for severity, threshold, colour in SEVERITY_BANDS:
        if ratio >= threshold:
            return severity, colour, ratio
    return MINOR, (0, 215, 255), ratio
