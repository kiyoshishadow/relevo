import bcrypt from 'bcryptjs';
import { pathToFileURL } from 'node:url';
import { config } from '../server/config.js';
import { pool, withTransaction, closePool } from '../server/db/pool.js';
import { runMigrations } from '../server/db/migrate.js';
import { evaluateCoverage, todayIso } from '../server/domain/coverage.js';
import { fingerprintPayment, hashToken } from '../server/domain/tokens.js';
import { formatCents } from '../server/domain/money.js';

const SYNTHETIC_NOTICE = 'Datos 100% sintéticos para demostración académica. No usar en producción.';

function databaseNameFromUrl(url) {
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  } catch {
    return '';
  }
}

function daysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function dateDaysAgo(days) {
  return todayIso(daysAgo(days));
}

async function insertUser(client, { email, fullName, role, passwordHash }) {
  return (
    await client.query(
      `INSERT INTO users (email, full_name, role, password_hash)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [email, fullName, role, passwordHash],
    )
  ).rows[0].id;
}

async function insertClient(client, data) {
  return (
    await client.query(
      `INSERT INTO clients (full_name, document_id, phone, email, address, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [data.fullName, data.documentId, data.phone, data.email, data.address, daysAgo(data.daysAgo ?? 30)],
    )
  ).rows[0];
}

async function insertCoverage(client, data) {
  return (
    await client.query(
      `INSERT INTO coverages (brand, name, plan, months, exclusions, replacement_policy)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       RETURNING *`,
      [
        data.brand,
        data.name,
        data.plan,
        data.months,
        JSON.stringify(data.exclusions),
        data.replacementPolicy,
      ],
    )
  ).rows[0];
}

async function insertTerminal(client, data) {
  const row = (
    await client.query(
      `INSERT INTO terminals
         (client_id, brand, model, purchase_date, accessories, initial_condition, coverage_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        data.clientId,
        data.brand,
        data.model,
        data.purchaseDate,
        data.accessories,
        data.initialCondition,
        data.coverageId,
      ],
    )
  ).rows[0];
  for (const imei of data.imeis || []) {
    await client.query('INSERT INTO terminal_imeis (terminal_id, imei) VALUES ($1, $2)', [
      row.id,
      imei,
    ]);
  }
  return { ...row, imeis: data.imeis || [] };
}

async function insertCase(client, data) {
  const sequence = (await client.query("SELECT nextval('case_number_seq') AS value")).rows[0].value;
  const caseNumber = `RV-${new Date().getUTCFullYear()}-${String(sequence).padStart(6, '0')}`;
  const createdAt = daysAgo(data.createdDaysAgo);
  const diagnosedAt = data.diagnosis ? daysAgo(data.diagnosedDaysAgo ?? data.createdDaysAgo) : null;
  const deliveredAt = data.status === 'delivered' ? daysAgo(data.deliveredDaysAgo ?? 1) : null;
  const cancelledAt = data.status === 'cancelled' ? daysAgo(data.cancelledDaysAgo ?? 1) : null;

  const evaluation = data.evaluation || null;
  const caseRow = (
    await client.query(
      `INSERT INTO cases
         (case_number, client_id, terminal_id, reported_problem, technician_id, status,
          tracking_token_hash, diagnosis, problem_type, excluded_reason, coverage_covered,
          coverage_evaluation, coverage_override, override_reason, diagnosed_at,
          created_by, created_at, updated_at, delivered_at, cancelled_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14,
               $15, $16, $17, $17, $18, $19)
       RETURNING *`,
      [
        caseNumber,
        data.clientId,
        data.terminalId,
        data.reportedProblem,
        data.technicianId,
        data.status,
        hashToken(data.token),
        data.diagnosis || null,
        data.problemType || null,
        data.excludedReason || null,
        evaluation ? evaluation.covered : null,
        evaluation ? JSON.stringify(evaluation) : null,
        false,
        null,
        diagnosedAt,
        data.createdBy,
        createdAt,
        deliveredAt,
        cancelledAt,
      ],
    )
  ).rows[0];

  for (const step of data.history) {
    await client.query(
      `INSERT INTO case_history (case_id, from_status, to_status, note, changed_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        caseRow.id,
        step.from || null,
        step.to,
        step.note || null,
        step.actorId || data.createdBy,
        daysAgo(step.daysAgo),
      ],
    );
  }

  return caseRow;
}

async function insertQuote(client, caseId, data) {
  const totalCents = data.items.reduce(
    (sum, item) => sum + item.quantity * item.unitPriceCents,
    0,
  );
  const quote = (
    await client.query(
      `INSERT INTO case_quotes
         (case_id, version, note, total_cents, status, created_by, created_at,
          decided_at, decided_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        caseId,
        data.version || 1,
        data.note || null,
        totalCents,
        data.status,
        data.createdBy,
        daysAgo(data.createdDaysAgo ?? 2),
        data.status === 'accepted' || data.status === 'rejected'
          ? daysAgo(data.decidedDaysAgo ?? 1)
          : null,
        data.status === 'accepted' || data.status === 'rejected' ? data.decidedBy : null,
      ],
    )
  ).rows[0];

  for (const item of data.items) {
    await client.query(
      `INSERT INTO case_quote_items
         (quote_id, description, quantity, unit_price_cents, line_total_cents)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        quote.id,
        item.description,
        item.quantity,
        item.unitPriceCents,
        item.quantity * item.unitPriceCents,
      ],
    );
  }
  return quote;
}

async function insertPayment(client, caseId, data) {
  return (
    await client.query(
      `INSERT INTO payments
         (case_id, amount_cents, method, reference, idempotency_key, request_hash,
          recorded_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        caseId,
        data.amountCents,
        data.method,
        data.reference || null,
        data.idempotencyKey,
        fingerprintPayment({
          amountCents: data.amountCents,
          method: data.method,
          reference: data.reference || '',
        }),
        data.recordedBy,
        daysAgo(data.daysAgo ?? 1),
      ],
    )
  ).rows[0];
}

async function insertAction(client, caseId, data) {
  await client.query(
    `INSERT INTO case_actions (case_id, description, parts, created_by, created_at)
     VALUES ($1, $2, $3::jsonb, $4, $5)`,
    [caseId, data.description, JSON.stringify(data.parts || []), data.createdBy, daysAgo(data.daysAgo ?? 1)],
  );
}

async function insertLoan(client, caseId, data) {
  const loan = (
    await client.query(
      `INSERT INTO loans
         (case_id, loan_device_id, condition_out, condition_in, loaned_by,
          loaned_at, returned_by, returned_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        caseId,
        data.deviceId,
        data.conditionOut,
        data.conditionIn || null,
        data.loanedBy,
        daysAgo(data.loanedDaysAgo ?? 2),
        data.returnedBy || null,
        data.returnedDaysAgo === undefined ? null : daysAgo(data.returnedDaysAgo),
      ],
    )
  ).rows[0];
  if (!loan.returned_at) {
    await client.query("UPDATE loan_devices SET status = 'loaned' WHERE id = $1", [data.deviceId]);
  }
  return loan;
}

export async function seedDatabase() {
  const dbName = databaseNameFromUrl(config.databaseUrl);
  if (/sicis/i.test(dbName)) {
    throw new Error('El seed se niega a operar sobre una base relacionada con SICIS');
  }
  if (config.env === 'production' && !config.allowSeed) {
    throw new Error('Seed bloqueado en NODE_ENV=production; use ALLOW_SEED=1 solo en base sintética');
  }

  await runMigrations();
  const passwordHash = await bcrypt.hash(config.seedDemoPassword, 12);
  const created = await withTransaction(async (client) => {
    await client.query(`
      TRUNCATE TABLE
        notification_outbox, audit_log, case_replacements, case_actions, loans,
        loan_devices, payments, case_quote_items, case_quotes, case_history,
        cases, terminal_imeis, terminals, coverages, clients, sessions, users
      RESTART IDENTITY CASCADE
    `);
    await client.query('ALTER SEQUENCE case_number_seq RESTART WITH 1');

    const adminId = await insertUser(client, {
      email: 'admin@relevo.test',
      fullName: 'Elena Campos',
      role: 'admin',
      passwordHash,
    });
    const receptionId = await insertUser(client, {
      email: 'recepcion@relevo.test',
      fullName: 'Marta Ruiz',
      role: 'reception',
      passwordHash,
    });
    const tech1Id = await insertUser(client, {
      email: 'tecnico@relevo.test',
      fullName: 'Carlos Mejía',
      role: 'technician',
      passwordHash,
    });
    const tech2Id = await insertUser(client, {
      email: 'tecnico2@relevo.test',
      fullName: 'Ana Torres',
      role: 'technician',
      passwordHash,
    });

    const clients = [];
    clients.push(
      await insertClient(client, {
        fullName: 'Lucía Herrera',
        documentId: 'DUI-00000001',
        phone: '5550-1001',
        email: 'lucia.herrera@example.test',
        address: 'Calle Los Álamos 12, San Salvador',
        daysAgo: 120,
      }),
    );
    clients.push(
      await insertClient(client, {
        fullName: 'Diego Salazar',
        documentId: 'DUI-00000002',
        phone: '5550-1002',
        email: 'diego.salazar@example.test',
        address: 'Av. Central 45, Santa Tecla',
        daysAgo: 95,
      }),
    );
    clients.push(
      await insertClient(client, {
        fullName: 'Valeria Menjívar',
        documentId: 'DUI-00000003',
        phone: '5550-1003',
        email: 'valeria.menjivar@example.test',
        address: 'Colonia Escalón 8, San Salvador',
        daysAgo: 80,
      }),
    );
    clients.push(
      await insertClient(client, {
        fullName: 'Andrés Pineda',
        documentId: 'DUI-00000004',
        phone: '5550-1004',
        email: 'andres.pineda@example.test',
        address: 'Barrio El Centro 3, Suchitoto',
        daysAgo: 60,
      }),
    );
    clients.push(
      await insertClient(client, {
        fullName: 'Sofía Ramírez',
        documentId: 'DUI-00000005',
        phone: '5550-1005',
        email: 'sofia.ramirez@example.test',
        address: 'Residencial Las Flores 21, San Miguel',
        daysAgo: 40,
      }),
    );

    const coverageGeneral = await insertCoverage(client, {
      brand: null,
      name: 'Garantía Relevo 12',
      plan: 'total',
      months: 12,
      exclusions: ['daño por líquidos'],
      replacementPolicy: 'new',
    });
    const coverageSamsung = await insertCoverage(client, {
      brand: 'Samsung',
      name: 'Protección Samsung 6',
      plan: 'pantalla',
      months: 6,
      exclusions: ['robo'],
      replacementPolicy: 'continue',
    });
    const coverageApple = await insertCoverage(client, {
      brand: 'Apple',
      name: 'AppleCare Relevo 24',
      plan: 'premium',
      months: 24,
      exclusions: ['pérdida'],
      replacementPolicy: 'new',
    });
    const coverageXiaomi = await insertCoverage(client, {
      brand: 'Xiaomi',
      name: 'Cobertura Xiaomi 3',
      plan: 'básica',
      months: 3,
      exclusions: ['golpe'],
      replacementPolicy: 'continue',
    });

    const terminals = {};
    terminals.a15 = await insertTerminal(client, {
      clientId: clients[0].id,
      brand: 'Samsung',
      model: 'Galaxy A15',
      imeis: ['356789012345671', '356789012345672'],
      purchaseDate: dateDaysAgo(120),
      accessories: 'Cargador y funda',
      initialCondition: 'Buen estado, rayones leves',
      coverageId: coverageGeneral.id,
    });
    terminals.iphone = await insertTerminal(client, {
      clientId: clients[0].id,
      brand: 'Apple',
      model: 'iPhone 13',
      imeis: ['356789012345673'],
      purchaseDate: dateDaysAgo(65),
      accessories: 'Cable Lightning',
      initialCondition: 'Muy buen estado',
      coverageId: coverageApple.id,
    });
    terminals.redmi = await insertTerminal(client, {
      clientId: clients[1].id,
      brand: 'Xiaomi',
      model: 'Redmi Note 12',
      imeis: [],
      purchaseDate: dateDaysAgo(70),
      accessories: 'Cargador',
      initialCondition: 'Marco golpeado en esquina inferior',
      coverageId: coverageXiaomi.id,
    });
    terminals.s23 = await insertTerminal(client, {
      clientId: clients[2].id,
      brand: 'Samsung',
      model: 'Galaxy S23',
      imeis: ['356789012345674'],
      purchaseDate: dateDaysAgo(540),
      accessories: 'Sin accesorios',
      initialCondition: 'Desgaste normal',
      coverageId: coverageSamsung.id,
    });
    terminals.moto = await insertTerminal(client, {
      clientId: clients[3].id,
      brand: 'Motorola',
      model: 'Moto G54',
      imeis: [],
      purchaseDate: dateDaysAgo(25),
      accessories: 'Cargador y audífonos',
      initialCondition: 'Como nuevo',
      coverageId: coverageGeneral.id,
    });
    terminals.s24 = await insertTerminal(client, {
      clientId: clients[0].id,
      brand: 'Samsung',
      model: 'Galaxy S24',
      imeis: ['356789012345675'],
      purchaseDate: dateDaysAgo(35),
      accessories: 'Cargador',
      initialCondition: 'Buen estado',
      coverageId: coverageGeneral.id,
    });
    terminals.pixel = await insertTerminal(client, {
      clientId: clients[4].id,
      brand: 'Google',
      model: 'Pixel 8',
      imeis: ['356789012345676'],
      purchaseDate: dateDaysAgo(90),
      accessories: 'Cable USB-C',
      initialCondition: 'Buen estado',
      coverageId: coverageGeneral.id,
    });
    terminals.a54 = await insertTerminal(client, {
      clientId: clients[1].id,
      brand: 'Samsung',
      model: 'Galaxy A54',
      imeis: ['356789012345677'],
      purchaseDate: dateDaysAgo(150),
      accessories: 'Funda',
      initialCondition: 'Buen estado',
      coverageId: coverageGeneral.id,
    });

    const devices = [];
    devices.push(
      (
        await client.query(
          `INSERT INTO loan_devices (asset_tag, brand, model, condition)
           VALUES ('LP-001', 'Samsung', 'Galaxy A05', 'Bueno, batería al 90%') RETURNING *`,
        )
      ).rows[0],
    );
    devices.push(
      (
        await client.query(
          `INSERT INTO loan_devices (asset_tag, brand, model, condition)
           VALUES ('LP-002', 'Nokia', '105', 'Bueno, teclado físico') RETURNING *`,
        )
      ).rows[0],
    );
    devices.push(
      (
        await client.query(
          `INSERT INTO loan_devices (asset_tag, brand, model, condition)
           VALUES ('LP-003', 'Apple', 'iPhone SE 2020', 'Regular, batería al 78%') RETURNING *`,
        )
      ).rows[0],
    );

    const evaluationFor = (coverage, terminal, problemType) =>
      evaluateCoverage({
        coverage,
        purchaseDate: terminal.purchase_date,
        terminalBrand: terminal.brand,
        problemType,
      });

    const evalDelivered = evaluationFor(
      coverageGeneral,
      terminals.a54,
      'pantalla',
    );
    const evaluationReady = evaluationFor(coverageGeneral, terminals.pixel, 'cámara');
    const evaluationRepairing = evaluationFor(coverageGeneral, terminals.s24, 'puerto de carga');
    const evaluationIphone = evaluationFor(coverageApple, terminals.iphone, 'pantalla');
    const evaluationRedmi = evaluationFor(coverageXiaomi, terminals.redmi, 'golpe');
    const evaluationS23 = evaluationFor(coverageSamsung, terminals.s23, 'batería');

    const caseDelivered = await insertCase(client, {
      clientId: clients[1].id,
      terminalId: terminals.a54.id,
      technicianId: tech1Id,
      reportedProblem: 'La pantalla no responde al tacto',
      status: 'delivered',
      token: 'synthetic-demo-token-delivered-0007',
      diagnosis: 'Digitizador dañado; se reemplazó el módulo de pantalla.',
      problemType: 'pantalla',
      evaluation: evalDelivered,
      createdBy: receptionId,
      createdDaysAgo: 12,
      diagnosedDaysAgo: 11,
      deliveredDaysAgo: 2,
      history: [
        { from: null, to: 'received', note: 'Caso creado en recepción', daysAgo: 12 },
        { from: 'received', to: 'diagnosing', note: 'Diagnóstico iniciado', daysAgo: 11 },
        { from: 'diagnosing', to: 'repairing', note: 'Cobertura aplica', daysAgo: 11 },
        { from: 'repairing', to: 'ready', note: 'Equipo listo para entrega', daysAgo: 5 },
        { from: 'ready', to: 'delivered', note: 'Equipo entregado al cliente', daysAgo: 2 },
      ],
    });
    await insertAction(client, caseDelivered.id, {
      description: 'Reemplazo de módulo de pantalla y prueba táctil',
      parts: ['Módulo de pantalla A54', 'Adhesivo'],
      createdBy: tech1Id,
      daysAgo: 6,
    });

    const caseReady = await insertCase(client, {
      clientId: clients[4].id,
      terminalId: terminals.pixel.id,
      technicianId: tech2Id,
      reportedProblem: 'La cámara frontal se ve borrosa',
      status: 'ready',
      token: 'synthetic-demo-token-ready-0006',
      diagnosis: 'Lente frontal con residuo; limpieza y calibración completadas.',
      problemType: 'cámara',
      evaluation: evaluationReady,
      createdBy: receptionId,
      createdDaysAgo: 6,
      diagnosedDaysAgo: 5,
      history: [
        { from: null, to: 'received', note: 'Caso creado en recepción', daysAgo: 6 },
        { from: 'received', to: 'diagnosing', note: 'Diagnóstico iniciado', daysAgo: 5 },
        { from: 'diagnosing', to: 'repairing', note: 'Cobertura aplica', daysAgo: 5 },
        { from: 'repairing', to: 'ready', note: 'Equipo listo para entrega', daysAgo: 1 },
      ],
    });
    await insertAction(client, caseReady.id, {
      description: 'Limpieza de lente frontal y calibración de cámara',
      parts: ['Kit de limpieza'],
      createdBy: tech2Id,
      daysAgo: 2,
    });
    await insertLoan(client, caseReady.id, {
      deviceId: devices[1].id,
      conditionOut: 'Bueno, teclado físico',
      conditionIn: 'Devuelto sin daños',
      loanedBy: receptionId,
      returnedBy: receptionId,
      loanedDaysAgo: 5,
      returnedDaysAgo: 3,
    });

    const caseAwaitingPayment = await insertCase(client, {
      clientId: clients[2].id,
      terminalId: terminals.s23.id,
      technicianId: tech2Id,
      reportedProblem: 'La batería se agota en pocas horas',
      status: 'awaiting_payment',
      token: 'synthetic-demo-token-payment-0004',
      diagnosis: 'Batería degradada; requiere reemplazo. Cobertura vencida.',
      problemType: 'batería',
      evaluation: evaluationS23,
      createdBy: receptionId,
      createdDaysAgo: 5,
      diagnosedDaysAgo: 4,
      history: [
        { from: null, to: 'received', note: 'Caso creado en recepción', daysAgo: 5 },
        { from: 'received', to: 'diagnosing', note: 'Diagnóstico iniciado', daysAgo: 4 },
        {
          from: 'diagnosing',
          to: 'awaiting_approval',
          note: 'Cobertura vencida; se requiere cotización',
          daysAgo: 4,
        },
        {
          from: 'awaiting_approval',
          to: 'awaiting_payment',
          note: 'Cotización aceptada; pendiente de pago',
          daysAgo: 3,
        },
      ],
    });
    await insertQuote(client, caseAwaitingPayment.id, {
      version: 1,
      note: 'Repuesto original y mano de obra',
      status: 'accepted',
      createdBy: receptionId,
      createdDaysAgo: 4,
      decidedBy: receptionId,
      decidedDaysAgo: 3,
      items: [
        {
          description: 'Batería Samsung S23 original',
          quantity: 1,
          unitPriceCents: 6500,
        },
        {
          description: 'Mano de obra',
          quantity: 1,
          unitPriceCents: 1500,
        },
      ],
    });
    await insertPayment(client, caseAwaitingPayment.id, {
      amountCents: 3000,
      method: 'cash',
      reference: 'Recibo sintético 001',
      idempotencyKey: 'seed-payment-case4-001',
      recordedBy: receptionId,
      daysAgo: 1,
    });

    const caseRepairing = await insertCase(client, {
      clientId: clients[0].id,
      terminalId: terminals.s24.id,
      technicianId: tech1Id,
      reportedProblem: 'No carga por USB-C',
      status: 'repairing',
      token: 'synthetic-demo-token-repairing-0005',
      diagnosis: 'Puerto de carga con suciedad y pines desgastados. Cobertura vigente.',
      problemType: 'puerto de carga',
      evaluation: evaluationRepairing,
      createdBy: receptionId,
      createdDaysAgo: 4,
      diagnosedDaysAgo: 3,
      history: [
        { from: null, to: 'received', note: 'Caso creado en recepción', daysAgo: 4 },
        { from: 'received', to: 'diagnosing', note: 'Diagnóstico iniciado', daysAgo: 3 },
        { from: 'diagnosing', to: 'repairing', note: 'Cobertura aplica', daysAgo: 3 },
      ],
    });
    await insertLoan(client, caseRepairing.id, {
      deviceId: devices[0].id,
      conditionOut: 'Bueno, batería al 90%',
      loanedBy: receptionId,
      loanedDaysAgo: 3,
    });

    const caseAwaitingApproval = await insertCase(client, {
      clientId: clients[1].id,
      terminalId: terminals.redmi.id,
      technicianId: tech1Id,
      reportedProblem: 'Golpe en la esquina; la pantalla muestra líneas',
      status: 'awaiting_approval',
      token: 'synthetic-demo-token-approval-0003',
      diagnosis: 'Pantalla dañada por golpe. La cobertura excluye golpes.',
      problemType: 'golpe',
      excludedReason: 'Golpe físico fuera de cobertura',
      evaluation: evaluationRedmi,
      createdBy: receptionId,
      createdDaysAgo: 3,
      diagnosedDaysAgo: 2,
      history: [
        { from: null, to: 'received', note: 'Caso creado en recepción', daysAgo: 3 },
        { from: 'received', to: 'diagnosing', note: 'Diagnóstico iniciado', daysAgo: 2 },
        {
          from: 'diagnosing',
          to: 'awaiting_approval',
          note: 'Cobertura no aplica; pendiente de cotización',
          daysAgo: 2,
        },
      ],
    });
    await insertQuote(client, caseAwaitingApproval.id, {
      version: 1,
      note: 'Cotización sujeta a revisión del marco',
      status: 'pending',
      createdBy: receptionId,
      createdDaysAgo: 2,
      items: [
        { description: 'Pantalla Redmi Note 12', quantity: 1, unitPriceCents: 5500 },
        { description: 'Revisión de marco', quantity: 1, unitPriceCents: 1000 },
      ],
    });

    const caseDiagnosing = await insertCase(client, {
      clientId: clients[0].id,
      terminalId: terminals.iphone.id,
      technicianId: tech2Id,
      reportedProblem: 'Pantalla con líneas y táctil intermitente',
      status: 'diagnosing',
      token: 'synthetic-demo-token-diagnosing-0002',
      diagnosis: 'Posible flex de pantalla; pendiente prueba de sustitución.',
      problemType: 'pantalla',
      evaluation: evaluationIphone,
      createdBy: receptionId,
      createdDaysAgo: 2,
      diagnosedDaysAgo: 1,
      history: [
        { from: null, to: 'received', note: 'Caso creado en recepción', daysAgo: 2 },
        { from: 'received', to: 'diagnosing', note: 'Diagnóstico iniciado', daysAgo: 1 },
      ],
    });

    const caseReceived = await insertCase(client, {
      clientId: clients[0].id,
      terminalId: terminals.a15.id,
      technicianId: tech1Id,
      reportedProblem: 'El equipo no enciende y se calienta',
      status: 'received',
      token: 'synthetic-demo-token-received-0001',
      createdBy: receptionId,
      createdDaysAgo: 1,
      history: [
        { from: null, to: 'received', note: 'Caso creado en recepción', daysAgo: 1 },
      ],
    });

    const demoCases = [
      caseReceived,
      caseDiagnosing,
      caseAwaitingApproval,
      caseAwaitingPayment,
      caseRepairing,
      caseReady,
      caseDelivered,
    ].map((row) => ({
      case_number: row.case_number,
      status: row.status,
      tracking_token: {
        [caseReceived.id]: 'synthetic-demo-token-received-0001',
        [caseDiagnosing.id]: 'synthetic-demo-token-diagnosing-0002',
        [caseAwaitingApproval.id]: 'synthetic-demo-token-approval-0003',
        [caseAwaitingPayment.id]: 'synthetic-demo-token-payment-0004',
        [caseRepairing.id]: 'synthetic-demo-token-repairing-0005',
        [caseReady.id]: 'synthetic-demo-token-ready-0006',
        [caseDelivered.id]: 'synthetic-demo-token-delivered-0007',
      }[row.id],
    }));

    return {
      users: [
        { email: 'admin@relevo.test', role: 'admin' },
        { email: 'recepcion@relevo.test', role: 'reception' },
        { email: 'tecnico@relevo.test', role: 'technician' },
        { email: 'tecnico2@relevo.test', role: 'technician' },
      ],
      clients: clients.length,
      terminals: Object.keys(terminals).length,
      cases: demoCases,
      paymentTotal: formatCents(3000),
      devices: devices.length,
    };
  });

  return { ...created, password: config.seedDemoPassword };
}

async function main() {
  const summary = await seedDatabase();
  console.log(SYNTHETIC_NOTICE);
  console.log(`Usuarios demo (contraseña: ${summary.password}):`);
  for (const user of summary.users) console.log(`  ${user.email} (${user.role})`);
  console.log(`Clientes: ${summary.clients}; terminales: ${summary.terminals}; dispositivos de préstamo: ${summary.devices}`);
  console.log('Casos y tokens de seguimiento sintéticos:');
  for (const item of summary.cases) {
    console.log(`  ${item.case_number} [${item.status}] token=${item.tracking_token}`);
  }
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main()
    .catch((error) => {
      console.error(`db:seed falló: ${error.message}`);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closePool().catch(() => {});
    });
}
