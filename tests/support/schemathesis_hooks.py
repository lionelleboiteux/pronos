"""Harness realism fix for NFR-RATE-01 (see 04-green-evidence.v1.md).

Schemathesis fuzzes one operation from a single OS process, so without this
hook every generated case would appear to the server as the same client IP —
a burst no real distinct user ever sends, and exactly what the per-IP rate
limiter exists to reject. This gives each generated case its own simulated
source IP via X-Forwarded-For, matching how distinct real users actually
present to the deployed API (Edge Function behind a fronting proxy). It does
not touch any test assertion or the checks Schemathesis runs — only what
"one request" looks like on the wire.
"""

import random

import schemathesis


@schemathesis.hook
def before_call(context, case, **kwargs):
    if case.headers is None:
        case.headers = {}
    case.headers["X-Forwarded-For"] = "203.0.{}.{}".format(
        random.randint(0, 255), random.randint(1, 254)
    )
