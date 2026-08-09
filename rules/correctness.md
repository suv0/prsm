# Correctness rules

- Nullability must be handled at boundaries.
- Prefer explicit NotFound / validation errors over runtime crashes.
- Async work must not ignore rejected promises.
- Shared mutable state needs a concurrency story.
