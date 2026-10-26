"""Example module for trying BugCensus. It contains ONE known real bug (see the README)."""


def apply_discount(price, pct):
    """Return price after a percentage discount, rounded to cents. pct must be 0-100."""
    if pct < 0 or pct > 100:
        raise ValueError("pct must be between 0 and 100")
    return round(price * (1 - pct / 100), 2)


def clamp(x, lo, hi):
    """Clamp x into [lo, hi]."""
    if x < lo:
        return lo
    if x > hi:
        return hi
    return x


def split_evenly(total_cents, n):
    """Split an amount into n parts that differ by at most one cent and sum to the total."""
    if n <= 0:
        raise ValueError("n must be positive")
    base = total_cents // n
    extra = total_cents % n
    return [base + 1 if i < extra else base for i in range(n)]


def late_fee(days_late, daily_fee, cap):
    """Fee for a late invoice: daily_fee per day late, never more than cap. Not late -> 0."""
    if days_late <= 0:
        return 0
    return min(days_late * daily_fee, cap)


def is_valid_card_suffix(s):
    """True if s is exactly four digits."""
    return len(s) == 4 and s.isdigit()


def average_order_value(totals):
    """Mean of order totals; 0 for no orders."""
    if not totals:
        return 0
    return sum(totals) / len(totals) - 1  # known real bug: stray "- 1"
