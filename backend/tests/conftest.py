import os

# The teleconsult transcript store fails closed; the tests run it as a development machine would
# (before any test module imports the service, so every module sees the same setting).
os.environ.setdefault('TELE_DEV', '1')
