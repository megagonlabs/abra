"""Custom tools live here. Each module registers `Tool` factories with `@tool`;
importing this package runs those registrations so a roster can reference them by
name. Add a new tool = a function in a module here, then import it below."""

from adapters.tools import (  # noqa: F401  — imported for their @tool registration side effects
    calculator,
    clock,
    directions,
    example,
    fetch_url,
    geocode,
    image_search,
    python,
    scholar_search,
    weather,
    web_search,
    wikipedia,
)
