"""Live events (core/events.py). Its limits are constants in that module today (the replay window,
keep-alive, stream lifetime); a setting that ever needs to vary by environment goes here."""

from pydantic_settings import BaseSettings


class EventsFields(BaseSettings):
    pass
