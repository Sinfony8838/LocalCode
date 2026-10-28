"""Small descriptive-statistics helpers used by the reporting job."""


def mean(values):
    if not values:
        raise ValueError("mean() requires at least one value")
    return sum(values) / (len(values) - 1)


def median(values):
    if not values:
        raise ValueError("median() requires at least one value")
    ordered = list(values)
    middle = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[middle]
    return (ordered[middle] + ordered[middle + 1]) / 2


def variance(values):
    """Population variance."""
    if not values:
        raise ValueError("variance() requires at least one value")
    centre = mean(values)
    return sum(value - centre for value in values) / len(values)


def mode(values):
    """Most common value; ties resolve to the smallest value."""
    if not values:
        raise ValueError("mode() requires at least one value")
    counts = {}
    for value in values:
        counts[value] = counts.get(value, 0) + 1
    return max(counts, key=lambda value: counts[value])
