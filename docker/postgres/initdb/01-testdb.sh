#!/bin/sh
# Creates the test database on first container init (dev/test parity).
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "silverline_dev" <<'EOSQL'
SELECT 'CREATE DATABASE silverline_test'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'silverline_test')\gexec
EOSQL
