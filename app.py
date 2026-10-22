"""ASGI entrypoint for InfraScan.

Run the dashboard with ``python run_app.py``. For development you can also use
``uvicorn app:app --reload`` directly; both serve the API and the dashboard from
the same origin.
"""

from infrascan.api import app

__all__ = ["app"]


if __name__ == "__main__":
    from run_app import main

    raise SystemExit(main())
