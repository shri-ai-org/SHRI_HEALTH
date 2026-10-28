"""The integration engine (D4, D25): partner messages through the outbox. Endpoints and services
call only `enqueue()` (api.py); the worker that sends, retries and dead-letters comes next."""
