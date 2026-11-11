"""The monthly spend guard for metered models (the Claude API).

Every gateway call records its input and output token counts on ``admin.ai_request`` (counts
only, never content). The month's spend is estimated from those counts at the list price of the
model each request used; once the estimate reaches the limit, the gateway stops calling the
model until the next month (UTC) and the operation fails with ``ai-unavailable``.

The estimate covers what this database's clinic has recorded: row-level security shows a clinic
its own requests only, and another environment using the same API key (a laptop and the demo
server, say) keeps its own count. It is a brake inside the application, not the account's
limit; the workspace's spend limit in the Claude Console stays the hard stop.
"""

from __future__ import annotations

import os
from collections.abc import Iterable
from dataclasses import dataclass
from decimal import Decimal

#: USD per million input and output tokens (list prices, 2026-11). A model that isn't listed
#: is not metered (the stub, a local model server): its requests cost nothing here.
PRICES: dict[str, tuple[Decimal, Decimal]] = {
    "claude-sonnet-5-5": (Decimal("2"), Decimal("10")),
    "claude-haiku-5-5": (Decimal("0.10"), Decimal("0.50")),
    "claude-opus-5-5": (Decimal("4"), Decimal("20")),
}
#: Stop at this estimate, to stay under the workspace's 160 USD monthly limit.
DEFAULT_LIMIT_USD = Decimal("140")
LIMIT_ENV = "SHRI_AI_MONTHLY_BUDGET_USD"
_MILLION = Decimal(1_000_000)


@dataclass(frozen=True)
class Usage:
    """One model's recorded tokens this month."""
    model: str
    input_tokens: int
    output_tokens: int


def price(model: str) -> tuple[Decimal, Decimal] | None:
    """The model's rates; a dated or suffixed name counts as its listed model."""
    return next((rates for name, rates in PRICES.items() if model.startswith(name)), None)


def cost(model: str, input_tokens: int, output_tokens: int) -> Decimal:
    """What one request cost at list price; 0 for a model that isn't metered."""
    rates = price(model)
    if rates is None:
        return Decimal(0)
    return (input_tokens * rates[0] + output_tokens * rates[1]) / _MILLION


def estimate(usage: Iterable[Usage]) -> Decimal:
    return sum((cost(u.model, u.input_tokens, u.output_tokens) for u in usage), Decimal(0))


def limit() -> Decimal:
    """The month's limit in USD: ``SHRI_AI_MONTHLY_BUDGET_USD``, else 140."""
    raw = os.environ.get(LIMIT_ENV, "")
    try:
        value = Decimal(raw) if raw else DEFAULT_LIMIT_USD
    except ArithmeticError:
        return DEFAULT_LIMIT_USD
    return value if value >= 0 else DEFAULT_LIMIT_USD
