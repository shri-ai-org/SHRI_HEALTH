-- Functions referenced by CHECK constraints; created by migration 0001 before any table.

-- US NPI check digit (Luhn over the 9-digit base with the 80840 prefix, i.e. constant 24).
CREATE OR REPLACE FUNCTION shri_npi_valid(npi text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN npi IS NULL OR npi !~ '^[0-9]{10}$' THEN false ELSE
    (10 - ((24 + (SELECT sum(CASE WHEN pos % 2 = 1
                                  THEN (substr(npi, pos, 1)::int * 2) / 10
                                       + (substr(npi, pos, 1)::int * 2) % 10
                                  ELSE substr(npi, pos, 1)::int END)
                    FROM generate_series(1, 9) AS pos)) % 10)) % 10
    = substr(npi, 10, 1)::int
  END
$$;
