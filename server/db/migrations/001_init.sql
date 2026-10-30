-- Esquema inicial de Relevo. Base PostgreSQL dedicada del proyecto.
-- Dinero: centavos enteros. Fechas de negocio: DATE. Marcas de tiempo: timestamptz.

CREATE TABLE users (
  id bigserial PRIMARY KEY,
  email text NOT NULL CHECK (position('@' in email) > 1),
  full_name text NOT NULL CHECK (length(btrim(full_name)) > 0),
  role text NOT NULL CHECK (role IN ('admin', 'reception', 'technician')),
  password_hash text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_unique ON users (lower(email));

CREATE TABLE sessions (
  id text PRIMARY KEY,
  user_id bigint REFERENCES users(id) ON DELETE CASCADE,
  csrf_token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  user_agent text,
  ip text
);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE clients (
  id bigserial PRIMARY KEY,
  full_name text NOT NULL CHECK (length(btrim(full_name)) > 1),
  document_id text,
  phone text NOT NULL CHECK (length(btrim(phone)) >= 5),
  email text NOT NULL CHECK (position('@' in email) > 1),
  address text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX clients_document_lower_unique
  ON clients (lower(document_id))
  WHERE document_id IS NOT NULL AND btrim(document_id) <> '';
CREATE INDEX clients_name_idx ON clients (lower(full_name));

CREATE TABLE coverages (
  id bigserial PRIMARY KEY,
  brand text,
  name text NOT NULL CHECK (length(btrim(name)) > 1),
  plan text NOT NULL CHECK (length(btrim(plan)) > 0),
  months integer NOT NULL CHECK (months BETWEEN 1 AND 120),
  exclusions jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(exclusions) = 'array'),
  replacement_policy text NOT NULL CHECK (replacement_policy IN ('new', 'continue')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE terminals (
  id bigserial PRIMARY KEY,
  client_id bigint NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  brand text NOT NULL CHECK (length(btrim(brand)) > 0),
  model text NOT NULL CHECK (length(btrim(model)) > 0),
  purchase_date date NOT NULL,
  accessories text NOT NULL DEFAULT '',
  initial_condition text NOT NULL CHECK (length(btrim(initial_condition)) > 1),
  coverage_id bigint REFERENCES coverages(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, client_id)
);
CREATE INDEX terminals_client_idx ON terminals (client_id);
CREATE INDEX terminals_brand_idx ON terminals (lower(brand));

CREATE TABLE terminal_imeis (
  terminal_id bigint NOT NULL REFERENCES terminals(id) ON DELETE CASCADE,
  imei text NOT NULL CHECK (imei ~ '^[0-9]{14,16}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (terminal_id, imei),
  UNIQUE (imei)
);

CREATE FUNCTION enforce_terminal_imei_limit() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT count(*) FROM terminal_imeis WHERE terminal_id = NEW.terminal_id) >= 2 THEN
    RAISE EXCEPTION 'Un terminal admite como máximo dos IMEI'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER terminal_imeis_limit
  BEFORE INSERT ON terminal_imeis
  FOR EACH ROW EXECUTE FUNCTION enforce_terminal_imei_limit();

CREATE SEQUENCE case_number_seq START WITH 1 INCREMENT BY 1;

CREATE TABLE cases (
  id bigserial PRIMARY KEY,
  case_number text NOT NULL UNIQUE,
  client_id bigint NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  terminal_id bigint NOT NULL,
  reported_problem text NOT NULL CHECK (length(btrim(reported_problem)) > 2),
  technician_id bigint REFERENCES users(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'received'
    CHECK (status IN ('received','diagnosing','awaiting_approval','awaiting_payment','repairing','ready','delivered','cancelled')),
  tracking_token_hash text NOT NULL UNIQUE,
  diagnosis text,
  problem_type text,
  excluded_reason text,
  coverage_covered boolean,
  coverage_evaluation jsonb,
  coverage_override boolean NOT NULL DEFAULT false,
  override_reason text,
  diagnosed_at timestamptz,
  created_by bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  cancelled_at timestamptz,
  CONSTRAINT cases_terminal_client_fk
    FOREIGN KEY (terminal_id, client_id) REFERENCES terminals(id, client_id) ON DELETE RESTRICT,
  CONSTRAINT cases_override_reason_check
    CHECK (coverage_override = false OR (override_reason IS NOT NULL AND btrim(override_reason) <> ''))
);
CREATE INDEX cases_status_idx ON cases (status);
CREATE INDEX cases_client_idx ON cases (client_id);
CREATE INDEX cases_terminal_idx ON cases (terminal_id);
CREATE INDEX cases_technician_idx ON cases (technician_id);
CREATE INDEX cases_created_idx ON cases (created_at DESC);

CREATE TABLE case_history (
  id bigserial PRIMARY KEY,
  case_id bigint NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  from_status text,
  to_status text NOT NULL CHECK (to_status IN ('received','diagnosing','awaiting_approval','awaiting_payment','repairing','ready','delivered','cancelled')),
  note text,
  changed_by bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (from_status IS NULL OR from_status IN ('received','diagnosing','awaiting_approval','awaiting_payment','repairing','ready','delivered','cancelled'))
);
CREATE INDEX case_history_case_idx ON case_history (case_id, created_at, id);

CREATE TABLE case_quotes (
  id bigserial PRIMARY KEY,
  case_id bigint NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  note text,
  total_cents bigint NOT NULL CHECK (total_cents >= 0),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','accepted','rejected','superseded')),
  created_by bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  decided_by bigint REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (case_id, version)
);
CREATE UNIQUE INDEX case_quotes_one_pending_idx
  ON case_quotes (case_id) WHERE status = 'pending';
CREATE UNIQUE INDEX case_quotes_one_accepted_idx
  ON case_quotes (case_id) WHERE status = 'accepted';

CREATE TABLE case_quote_items (
  id bigserial PRIMARY KEY,
  quote_id bigint NOT NULL REFERENCES case_quotes(id) ON DELETE CASCADE,
  description text NOT NULL CHECK (length(btrim(description)) > 0),
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_price_cents bigint NOT NULL CHECK (unit_price_cents >= 0),
  line_total_cents bigint NOT NULL CHECK (line_total_cents = quantity::bigint * unit_price_cents)
);

CREATE TABLE payments (
  id bigserial PRIMARY KEY,
  case_id bigint NOT NULL REFERENCES cases(id) ON DELETE RESTRICT,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  method text NOT NULL CHECK (method IN ('cash','card','transfer','other')),
  reference text,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  recorded_by bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (idempotency_key)
);
CREATE INDEX payments_case_idx ON payments (case_id, created_at);
CREATE INDEX payments_created_idx ON payments (created_at DESC);

CREATE TABLE loan_devices (
  id bigserial PRIMARY KEY,
  asset_tag text NOT NULL UNIQUE,
  brand text NOT NULL,
  model text NOT NULL,
  condition text NOT NULL DEFAULT '',
  notes text,
  status text NOT NULL DEFAULT 'available'
    CHECK (status IN ('available','loaned','retired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE loans (
  id bigserial PRIMARY KEY,
  case_id bigint NOT NULL REFERENCES cases(id) ON DELETE RESTRICT,
  loan_device_id bigint NOT NULL REFERENCES loan_devices(id) ON DELETE RESTRICT,
  condition_out text NOT NULL,
  condition_in text,
  loaned_by bigint REFERENCES users(id) ON DELETE SET NULL,
  loaned_at timestamptz NOT NULL DEFAULT now(),
  returned_by bigint REFERENCES users(id) ON DELETE SET NULL,
  returned_at timestamptz
);
CREATE UNIQUE INDEX loans_one_active_per_case_idx
  ON loans (case_id) WHERE returned_at IS NULL;
CREATE UNIQUE INDEX loans_one_active_per_device_idx
  ON loans (loan_device_id) WHERE returned_at IS NULL;

CREATE TABLE case_actions (
  id bigserial PRIMARY KEY,
  case_id bigint NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  description text NOT NULL CHECK (length(btrim(description)) > 2),
  parts jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(parts) = 'array'),
  created_by bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX case_actions_case_idx ON case_actions (case_id, created_at);

CREATE TABLE case_replacements (
  id bigserial PRIMARY KEY,
  case_id bigint NOT NULL UNIQUE REFERENCES cases(id) ON DELETE CASCADE,
  client_id bigint NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  terminal_id bigint NOT NULL,
  policy text NOT NULL CHECK (policy IN ('new','continue')),
  coverage_id bigint REFERENCES coverages(id) ON DELETE RESTRICT,
  created_by bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT case_replacements_terminal_client_fk
    FOREIGN KEY (terminal_id, client_id) REFERENCES terminals(id, client_id) ON DELETE RESTRICT
);

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  actor_id bigint REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  details jsonb,
  ip text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_created_idx ON audit_log (created_at DESC);
CREATE INDEX audit_entity_idx ON audit_log (entity_type, entity_id);

CREATE TABLE notification_outbox (
  id bigserial PRIMARY KEY,
  case_id bigint REFERENCES cases(id) ON DELETE SET NULL,
  recipient text NOT NULL CHECK (position('@' in recipient) > 1),
  channel text NOT NULL DEFAULT 'email' CHECK (channel IN ('email')),
  template text NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','sending','sent','failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text,
  provider text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE INDEX notification_outbox_pending_idx
  ON notification_outbox (status, next_attempt_at)
  WHERE status IN ('pending','sending');

CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER clients_set_updated_at BEFORE UPDATE ON clients
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER coverages_set_updated_at BEFORE UPDATE ON coverages
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER terminals_set_updated_at BEFORE UPDATE ON terminals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER cases_set_updated_at BEFORE UPDATE ON cases
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER loan_devices_set_updated_at BEFORE UPDATE ON loan_devices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
